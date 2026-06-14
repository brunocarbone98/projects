// Single PrismaClient instance for the whole process.
import "./env.js"; // ensure DATABASE_URL is loaded before the client reads it
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
