import { ApiError, notFound, validationError } from '../common/api.js';
import { serializable } from '../db/transaction.js';

const BLOCKING_STATUSES = ['PENDING', 'APPROVED'];

export function createLeaveService({ prisma, events = async () => {} }) {
  async function list(user, { page, limit, status }) {
    const where = {
      ...(user.role === 'EMPLOYEE' ? { userId: user.id } : {}),
      ...(status ? { status } : {}),
    };
    const [total, leaves] = await Promise.all([
      prisma.leave.count({ where }),
      prisma.leave.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, leaves };
  }

  async function apply(userId, { startDate, endDate, reason }) {
    if (endDate.getTime() < startDate.getTime()) {
      throw new ApiError(422, 'INVALID_DATE_RANGE', 'End date cannot be earlier than start date.');
    }
    return serializable(prisma, async (tx) => {
      const currentUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isActive: true },
      });
      if (!currentUser?.isActive) {
        throw new ApiError(401, 'UNAUTHORIZED', 'User account is unavailable');
      }
      const overlap = await tx.leave.findFirst({
        where: {
          userId,
          status: { in: BLOCKING_STATUSES },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { id: true },
      });
      if (overlap) {
        throw new ApiError(
          409,
          'LEAVE_OVERLAP',
          'A leave application already exists for overlapping dates',
        );
      }
      const leave = await tx.leave.create({
        data: { userId, startDate, endDate, reason, status: 'PENDING' },
      });
      await events(tx, userId, leave);
      return leave;
    }, { retries: 4 });
  }

  async function updateStatus(actor, leaveId, { status, rejectionReason }) {
    if (actor.role !== 'ADMIN') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
    if (status === 'REJECTED' && rejectionReason === null) throw validationError();
    if (status === 'APPROVED' && rejectionReason !== null) throw validationError();

    return serializable(prisma, async (tx) => {
      const existing = await tx.leave.findUnique({ where: { id: leaveId } });
      if (!existing) throw notFound('Leave application not found');
      if (existing.userId === actor.id) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'You cannot approve or reject your own leave application',
        );
      }
      if (existing.status !== 'PENDING') {
        throw new ApiError(
          409,
          'INVALID_LEAVE_STATE',
          'Only pending leave applications can be updated',
        );
      }
      const leave = await tx.leave.update({
        where: { id: leaveId },
        data: {
          status,
          approvedBy: actor.id,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
          updatedAt: new Date(),
        },
      });
      await events(tx, actor.id, leave, existing.status);
      return leave;
    }, { retries: 4 });
  }

  async function get(user, leaveId) {
    const leave = await prisma.leave.findUnique({
      where: { id: leaveId },
      include: { applicant: { select: { employeeName: true } } },
    });
    if (!leave || (user.role === 'EMPLOYEE' && leave.userId !== user.id)) {
      throw notFound('Leave application not found');
    }
    return leave;
  }

  return Object.freeze({ list, apply, updateStatus, get });
}
