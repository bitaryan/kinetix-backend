import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { ApiError, notFound, validationError } from '../common/api.js';
import { numberValue } from '../common/validation.js';

function coordinate(value) {
  if (value === null) return null;
  return new Prisma.Decimal(value).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function createClientLogService({ prisma, images }) {
  async function list(userId, { page, limit, search }) {
    const where = { userId };
    if (search) {
      const contains = escapeLike(search);
      where.OR = [
        { clientName: { contains, mode: 'insensitive' } },
        { companyName: { contains, mode: 'insensitive' } },
        { mobileNumber: { contains, mode: 'insensitive' } },
        { mailId: { contains, mode: 'insensitive' } },
      ];
    }
    const [totalCount, logs] = await Promise.all([
      prisma.clientLog.count({ where }),
      prisma.clientLog.findMany({
        where,
        orderBy: [{ logDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { totalCount, logs };
  }

  async function create(userId, input, selfie) {
    const { latitude, longitude } = input;
    if ((latitude === null) !== (longitude === null)) {
      throw validationError('latitude and longitude must be provided together');
    }
    numberValue(latitude, { required: false, min: -90, max: 90 });
    numberValue(longitude, { required: false, min: -180, max: 180 });
    numberValue(input.locationAccuracy, { required: false, min: 0 });

    const id = randomUUID();
    let selfiePath = null;
    try {
      if (selfie && typeof selfie.originalname === 'string' && selfie.originalname.trim() !== '') {
        selfiePath = await images.saveClientLogSelfie(selfie, userId, id);
      }
      return await prisma.clientLog.create({
        data: {
          id,
          userId,
          clientName: input.clientName,
          companyName: input.companyName,
          mobileNumber: input.mobileNumber,
          mailId: input.mailId,
          logDate: input.logDate,
          selfiePath,
          latitude: coordinate(latitude),
          longitude: coordinate(longitude),
          locationAccuracy: input.locationAccuracy,
        },
      });
    } catch (error) {
      if (selfiePath !== null) await images.deleteStoredFiles(selfiePath);
      throw error;
    }
  }

  async function remove(actor, id) {
    if (actor.role !== 'ADMIN') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
    const where = { id };
    const log = await prisma.clientLog.findFirst({ where });
    if (!log) throw notFound('Client log not found');
    const removed = await prisma.clientLog.deleteMany({ where });
    if (removed.count === 0) throw notFound('Client log not found');
    if (log.selfiePath) await images.deleteStoredFiles(log.selfiePath);
  }

  return Object.freeze({ list, create, remove });
}
