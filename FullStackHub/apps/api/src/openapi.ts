// Hand-authored OpenAPI 3.1 description of the public + authenticated API.
// Served as JSON at /api/v1/openapi.json and rendered at /api/v1/docs.
import { SERVICE_LEVELS, SHIPMENT_STATUSES, USER_ROLES } from "@shipping-hub/shared";

const ApiError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;

const Address = {
  type: "object",
  properties: {
    contactName: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string", nullable: true },
    city: { type: "string" },
    state: { type: "string", nullable: true },
    postalCode: { type: "string" },
    country: { type: "string", minLength: 2, maxLength: 2 },
    phone: { type: "string", nullable: true },
  },
} as const;

export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Shipping Hub API",
    version: "1.0.0",
    description:
      "Transactional shipping & tracking API. The public tracking endpoint needs no auth and is rate-limited.",
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "Auth" },
    { name: "Shipments" },
    { name: "Tracking", description: "Public, rate-limited, no authentication" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      ApiError,
      Address,
      ServiceLevel: { type: "string", enum: [...SERVICE_LEVELS] },
      ShipmentStatus: { type: "string", enum: [...SHIPMENT_STATUSES] },
      UserRole: { type: "string", enum: [...USER_ROLES] },
      RegisterInput: {
        type: "object",
        required: ["email", "password", "name"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
          name: { type: "string" },
        },
      },
      LoginInput: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
        },
      },
      AuthTokens: {
        type: "object",
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          tokenType: { type: "string", enum: ["Bearer"] },
          expiresIn: { type: "integer" },
        },
      },
      Parcel: {
        type: "object",
        required: ["weightGrams", "lengthCm", "widthCm", "heightCm"],
        properties: {
          weightGrams: { type: "integer", minimum: 1 },
          lengthCm: { type: "integer", minimum: 1 },
          widthCm: { type: "integer", minimum: 1 },
          heightCm: { type: "integer", minimum: 1 },
        },
      },
      CreateShipmentInput: {
        type: "object",
        required: ["origin", "destination", "serviceLevel", "parcel"],
        properties: {
          origin: { $ref: "#/components/schemas/Address" },
          destination: { $ref: "#/components/schemas/Address" },
          serviceLevel: { $ref: "#/components/schemas/ServiceLevel" },
          parcel: { $ref: "#/components/schemas/Parcel" },
        },
      },
      CreateTrackingEventInput: {
        type: "object",
        required: ["status"],
        properties: {
          status: { $ref: "#/components/schemas/ShipmentStatus" },
          location: { type: "string" },
          description: { type: "string" },
          occurredAt: { type: "string", format: "date-time" },
        },
      },
      TrackingEvent: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { $ref: "#/components/schemas/ShipmentStatus" },
          location: { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          occurredAt: { type: "string", format: "date-time" },
        },
      },
      Shipment: {
        type: "object",
        properties: {
          id: { type: "string" },
          trackingCode: { type: "string", example: "PTY-2026-001023-7" },
          status: { $ref: "#/components/schemas/ShipmentStatus" },
          serviceLevel: { $ref: "#/components/schemas/ServiceLevel" },
          origin: { $ref: "#/components/schemas/Address" },
          destination: { $ref: "#/components/schemas/Address" },
          parcel: { $ref: "#/components/schemas/Parcel" },
          priceCents: { type: "integer" },
          currency: { type: "string" },
          zoneCode: { type: "string" },
          estimatedDeliveryAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          events: { type: "array", items: { $ref: "#/components/schemas/TrackingEvent" } },
        },
      },
      PublicTracking: {
        type: "object",
        properties: {
          trackingCode: { type: "string" },
          status: { $ref: "#/components/schemas/ShipmentStatus" },
          serviceLevel: { $ref: "#/components/schemas/ServiceLevel" },
          origin: {
            type: "object",
            properties: { city: { type: "string" }, country: { type: "string" } },
          },
          destination: {
            type: "object",
            properties: { city: { type: "string" }, country: { type: "string" } },
          },
          estimatedDeliveryAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                status: { $ref: "#/components/schemas/ShipmentStatus" },
                location: { type: "string", nullable: true },
                description: { type: "string", nullable: true },
                occurredAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a customer account",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/RegisterInput" } },
          },
        },
        responses: { "201": { description: "Created" }, "409": { description: "Email taken" } },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Exchange credentials for tokens",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/LoginInput" } },
          },
        },
        responses: { "200": { description: "OK" }, "401": { description: "Invalid credentials" } },
      },
    },
    "/auth/refresh": {
      post: { tags: ["Auth"], summary: "Rotate the refresh token", responses: { "200": { description: "OK" } } },
    },
    "/auth/logout": {
      post: { tags: ["Auth"], summary: "Revoke a refresh token", responses: { "204": { description: "No content" } } },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current user",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthenticated" } },
      },
    },
    "/shipments": {
      get: {
        tags: ["Shipments"],
        summary: "List shipments (own for customers, all for staff)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "status", in: "query", schema: { $ref: "#/components/schemas/ShipmentStatus" } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: { "200": { description: "OK" } },
      },
      post: {
        tags: ["Shipments"],
        summary: "Create a shipment",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CreateShipmentInput" } },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Shipment" } },
            },
          },
        },
      },
    },
    "/shipments/{id}": {
      get: {
        tags: ["Shipments"],
        summary: "Get a shipment by id",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
      },
    },
    "/shipments/{id}/label": {
      get: {
        tags: ["Shipments"],
        summary: "Download the 4x6 PDF shipping label (owner or staff) via the labels service",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "PDF label",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/shipments/{id}/events": {
      post: {
        tags: ["Shipments"],
        summary: "Register a tracking event (courier/admin only)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateTrackingEventInput" },
            },
          },
        },
        responses: {
          "201": { description: "Updated shipment" },
          "403": { description: "Forbidden" },
          "409": {
            description: "Invalid state transition",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
          },
        },
      },
    },
    "/quote": {
      post: {
        tags: ["Tracking"],
        summary: "Public quote via the pricing microservice (no auth, rate-limited)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "destinationCountry",
                  "weightGrams",
                  "lengthCm",
                  "widthCm",
                  "heightCm",
                  "serviceLevel",
                ],
                properties: {
                  originCountry: { type: "string", default: "PA" },
                  destinationCountry: { type: "string" },
                  weightGrams: { type: "integer" },
                  lengthCm: { type: "integer" },
                  widthCm: { type: "integer" },
                  heightCm: { type: "integer" },
                  serviceLevel: { $ref: "#/components/schemas/ServiceLevel" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Quote" }, "429": { description: "Rate limited" } },
      },
    },
    "/tracking/{code}": {
      get: {
        tags: ["Tracking"],
        summary: "Public shipment tracking (no auth, rate-limited)",
        parameters: [
          {
            name: "code",
            in: "path",
            required: true,
            schema: { type: "string", example: "PTY-2026-001023-7" },
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PublicTracking" } },
            },
          },
          "404": { description: "Not found" },
          "429": { description: "Rate limited" },
        },
      },
    },
  },
} as const;

export const docsHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shipping Hub API — Reference</title>
  </head>
  <body>
    <script id="api-reference" type="application/json"></script>
    <script>
      fetch("/api/v1/openapi.json")
        .then((r) => r.text())
        .then((spec) => {
          document.getElementById("api-reference").textContent = spec;
        });
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
