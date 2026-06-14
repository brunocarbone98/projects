import type {
  PayInput,
  PayResultDto,
  PaymentDto,
  TopUpInput,
  WalletDto,
} from "@shipping-hub/shared";
import { Prisma } from "@prisma/client";
import type { AccessClaims } from "../auth/tokens.js";
import { toShipmentDto } from "../domain/serializers.js";
import { AppError, conflict, notFound } from "../http/errors.js";
import { prisma } from "../prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

const SHIPMENT_INCLUDE = {
  originAddress: true,
  destinationAddress: true,
  events: true,
} satisfies Prisma.ShipmentInclude;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

// Idempotency keys are scoped per user so one user's key can never collide with
// — or expose — another user's transaction.
function scopedKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function ensureUserWallet(db: Db, userId: string) {
  const existing = await db.walletAccount.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await db.walletAccount.create({ data: { kind: "USER", userId } });
  } catch (error) {
    if (isUniqueViolation(error)) return db.walletAccount.findUniqueOrThrow({ where: { userId } });
    throw error;
  }
}

async function ensureSystemAccount(db: Db, systemKey: "CASH" | "REVENUE") {
  const existing = await db.walletAccount.findUnique({ where: { systemKey } });
  if (existing) return existing;
  try {
    return await db.walletAccount.create({ data: { kind: systemKey, systemKey } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return db.walletAccount.findUniqueOrThrow({ where: { systemKey } });
    }
    throw error;
  }
}

async function accountBalance(db: Db, accountId: string): Promise<number> {
  const agg = await db.ledgerEntry.aggregate({
    _sum: { amountCents: true },
    where: { accountId },
  });
  return agg._sum.amountCents ?? 0;
}

export async function getWallet(userId: string): Promise<WalletDto> {
  const wallet = await ensureUserWallet(prisma, userId);
  const [balance, entries] = await Promise.all([
    accountBalance(prisma, wallet.id),
    prisma.ledgerEntry.findMany({
      where: { accountId: wallet.id },
      include: { transaction: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    balanceCents: balance,
    currency: wallet.currency,
    entries: entries.map((entry) => ({
      id: entry.id,
      amountCents: entry.amountCents,
      kind: entry.transaction.kind,
      description: entry.transaction.description,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/** Idempotent wallet top-up (credit user wallet, debit the system CASH account). */
export async function topUp(userId: string, input: TopUpInput): Promise<WalletDto> {
  const key = scopedKey(userId, input.idempotencyKey);
  const existing = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: key },
  });
  if (existing) return getWallet(userId);

  const wallet = await ensureUserWallet(prisma, userId);
  const cash = await ensureSystemAccount(prisma, "CASH");

  try {
    await prisma.$transaction(async (tx) => {
      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          idempotencyKey: key,
          kind: "TOPUP",
          description: `Wallet top-up ${dollars(input.amountCents)}`,
        },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { transactionId: ledgerTx.id, accountId: wallet.id, amountCents: input.amountCents },
          { transactionId: ledgerTx.id, accountId: cash.id, amountCents: -input.amountCents },
        ],
      });
    });
  } catch (error) {
    // A concurrent request with the same idempotency key already applied it.
    if (!isUniqueViolation(error)) throw error;
  }

  return getWallet(userId);
}

async function paymentDto(db: Db, paymentId: string): Promise<PaymentDto> {
  const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return {
    id: payment.id,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    shipmentId: payment.shipmentId,
    createdAt: payment.createdAt.toISOString(),
  };
}

async function buildPayResult(paymentId: string, userId: string): Promise<PayResultDto> {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!payment.shipmentId) throw notFound("Shipment not found");
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: payment.shipmentId },
    include: SHIPMENT_INCLUDE,
  });
  return {
    payment: await paymentDto(prisma, paymentId),
    wallet: await getWallet(userId),
    shipment: toShipmentDto(shipment),
  };
}

/**
 * Idempotent payment for a shipment's label: debits the wallet, credits REVENUE,
 * advances the shipment to LABEL_PAID. If `generateLabel` throws, the payment is
 * automatically reversed.
 */
export async function payForShipment(
  actor: AccessClaims,
  shipmentId: string,
  input: PayInput,
  generateLabel?: () => Promise<void>,
): Promise<PayResultDto> {
  const userId = actor.sub;
  const key = scopedKey(userId, input.idempotencyKey);

  const existingTx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: key },
    include: { payment: true },
  });
  if (existingTx?.payment) {
    return buildPayResult(existingTx.payment.id, userId);
  }

  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw notFound("Shipment not found");
  // Only the shipment's owner can pay for its label.
  if (shipment.userId !== userId) throw notFound("Shipment not found");
  if (shipment.status !== "CREATED") {
    throw conflict("ALREADY_PAID", "This shipment is not awaiting payment");
  }

  const amount = shipment.priceCents;
  const wallet = await ensureUserWallet(prisma, userId);
  const revenue = await ensureSystemAccount(prisma, "REVENUE");

  // SERIALIZABLE prevents concurrent overdraw. Under contention Postgres may
  // abort with a serialization failure (P2034) or a unique-key race (P2002);
  // resolve to the winning payment, or retry the transaction a few times.
  const commitPayment = async (): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const balance = await accountBalance(tx, wallet.id);
            if (balance < amount) {
              throw new AppError(402, "INSUFFICIENT_FUNDS", "Insufficient wallet balance");
            }
            const ledgerTx = await tx.ledgerTransaction.create({
              data: {
                idempotencyKey: key,
                kind: "PAYMENT",
                description: `Label payment for ${shipment.trackingCode}`,
              },
            });
            await tx.ledgerEntry.createMany({
              data: [
                { transactionId: ledgerTx.id, accountId: wallet.id, amountCents: -amount },
                { transactionId: ledgerTx.id, accountId: revenue.id, amountCents: amount },
              ],
            });
            const payment = await tx.payment.create({
              data: {
                userId,
                shipmentId,
                transactionId: ledgerTx.id,
                amountCents: amount,
                currency: shipment.currency,
                status: "COMPLETED",
              },
            });
            await tx.trackingEvent.create({
              data: {
                shipmentId,
                status: "LABEL_PAID",
                description: "Label paid",
                actorId: actor.sub,
                occurredAt: new Date(),
                recordedAt: new Date(),
              },
            });
            await tx.shipment.update({ where: { id: shipmentId }, data: { status: "LABEL_PAID" } });
            return payment.id;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isUniqueViolation(error) || isSerializationFailure(error)) {
          const won = await prisma.ledgerTransaction.findUnique({
            where: { idempotencyKey: key },
            include: { payment: true },
          });
          if (won?.payment) return won.payment.id;
          if (isSerializationFailure(error) && attempt < 3) continue;
        }
        throw error;
      }
    }
  };

  const paymentId = await commitPayment();

  if (generateLabel) {
    try {
      await generateLabel();
    } catch {
      await reversePayment(paymentId);
      throw new AppError(502, "LABEL_FAILED", "Label generation failed; the payment was reversed");
    }
  }

  return buildPayResult(paymentId, userId);
}

/** Compensating reversal: opposite ledger entries, mark payment REVERSED, undo status. */
export async function reversePayment(paymentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: { transaction: { include: { entries: true } } },
    });
    if (!payment || payment.status === "REVERSED") return;

    const reversal = await tx.ledgerTransaction.create({
      data: {
        idempotencyKey: `reversal:${payment.transactionId}`,
        kind: "REVERSAL",
        description: `Reversal of payment ${payment.id}`,
      },
    });
    await tx.ledgerEntry.createMany({
      data: payment.transaction.entries.map((entry) => ({
        transactionId: reversal.id,
        accountId: entry.accountId,
        amountCents: -entry.amountCents,
      })),
    });
    await tx.payment.update({ where: { id: payment.id }, data: { status: "REVERSED" } });

    if (payment.shipmentId) {
      // Only rewind a shipment still at LABEL_PAID — never one that already
      // advanced, which would break the state-machine invariant.
      const shipment = await tx.shipment.findUnique({ where: { id: payment.shipmentId } });
      if (shipment?.status === "LABEL_PAID") {
        await tx.trackingEvent.create({
          data: {
            shipmentId: payment.shipmentId,
            status: "CREATED",
            description: "Payment reversed",
            occurredAt: new Date(),
            recordedAt: new Date(),
          },
        });
        await tx.shipment.update({ where: { id: payment.shipmentId }, data: { status: "CREATED" } });
      }
    }
  });
}
