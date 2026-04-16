import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../editor/config.js';

let prisma = null;
let databaseState = {
  configured: false,
  connected: false,
  lastError: null,
  databaseUrl: null,
  checkedAt: null
};

function getConfiguredDatabaseUrl() {
  const config = loadConfig();
  return (
    process.env.DATABASE_URL ||
    config.database_url ||
    ''
  ).trim();
}

export function getDatabaseUrl() {
  return getConfiguredDatabaseUrl();
}

function maskDatabaseUrl(url) {
  if (!url) return '';
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

export function getDatabaseState() {
  return {
    ...databaseState,
    databaseUrl: maskDatabaseUrl(databaseState.databaseUrl)
  };
}

export function isDatabaseConfigured() {
  return Boolean(getConfiguredDatabaseUrl());
}

export function getPrisma() {
  const databaseUrl = getConfiguredDatabaseUrl();
  databaseState.databaseUrl = databaseUrl;
  databaseState.configured = Boolean(databaseUrl);

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  if (!prisma) {
    prisma = new PrismaClient({
      datasourceUrl: databaseUrl
    });
  }

  return prisma;
}

export async function checkDatabaseConnection() {
  const databaseUrl = getConfiguredDatabaseUrl();
  databaseState.databaseUrl = databaseUrl;
  databaseState.configured = Boolean(databaseUrl);
  databaseState.checkedAt = new Date().toISOString();

  if (!databaseUrl) {
    databaseState.connected = false;
    databaseState.lastError = 'DATABASE_URL is not configured';
    return getDatabaseState();
  }

  try {
    const client = getPrisma();
    await client.$queryRaw`SELECT 1`;
    databaseState.connected = true;
    databaseState.lastError = null;
  } catch (error) {
    databaseState.connected = false;
    databaseState.lastError = error.message;
  }

  return getDatabaseState();
}

export async function withDatabase(task) {
  const client = getPrisma();
  return task(client);
}

export async function disconnectDatabase() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
