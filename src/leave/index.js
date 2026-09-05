import express from 'express';

import { ApiError, sendSuccess, validationError } from '../common/api.js';
import { formatDateShort, parseDate } from '../common/dates.js';
import { enumValue, pageParams, requireObject, uuidValue } from '../common/validation.js';
import { createLeaveService } from './service.js';

const LISTABLE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const ACTION_STATUSES = ['APPROVED', 'REJECTED'];

function titleCaseStatus(status) {
  const lower = status.toLowerCase();
  return `${lower[0].toUpperCase()}${lower.slice(1)}`;
}

function parseLeaveDate(value) {
  if (typeof value !== 'string' || value.trim() === '') throw validationError();
  try {
    return parseDate(value);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
      throw validationError('Select a valid date');
    }
    throw error;
  }
}

function leaveListItem(leave) {
  return {
    id: leave.id,
    start_date: formatDateShort(leave.startDate),
    end_date: formatDateShort(leave.endDate),
    reason: leave.reason,
    status: titleCaseStatus(leave.status),
    created_at: leave.createdAt,
  };
}

function leaveCreated(leave) {
  return {
    id: leave.id,
    user_id: leave.userId,
    start_date: formatDateShort(leave.startDate),
    end_date: formatDateShort(leave.endDate),
    reason: leave.reason,
    status: titleCaseStatus(leave.status),
    created_at: leave.createdAt,
    message: 'Leave application submitted successfully',
  };
}

function leaveDetail(leave) {
  return {
    id: leave.id,
    user_id: leave.userId,
    applicant_name: leave.applicant?.employeeName ?? '',
    start_date: formatDateShort(leave.startDate),
    end_date: formatDateShort(leave.endDate),
    reason: leave.reason,
    status: titleCaseStatus(leave.status),
    rejection_reason: leave.rejectionReason ?? null,
    approved_by: leave.approvedBy ?? null,
    created_at: leave.createdAt,
    updated_at: leave.updatedAt,
  };
}

export function createLeaveRouter({ prisma, auth }) {
  const router = express.Router();
  const service = createLeaveService({ prisma });
  router.use(auth.authenticate);

  router.get('/', auth.requireRoles('EMPLOYEE', 'MANAGER', 'ADMIN'), async (req, res) => {
    const { page, limit } = pageParams(req.query);
    let status;
    if (req.query.status !== undefined) {
      if (req.query.status === 'CANCELLED') throw validationError();
      status = enumValue(req.query.status, LISTABLE_STATUSES);
    }

    const { total, leaves } = await service.list(req.principal.user, { page, limit, status });

    return sendSuccess(res, leaves.map(leaveListItem), 200, { total, page, limit });
  });

  router.post('/', auth.requireRoles('EMPLOYEE', 'MANAGER', 'ADMIN'), async (req, res) => {
    const payload = requireObject(req.body);
    if (typeof payload.start_date !== 'string'
        || payload.start_date.trim() === ''
        || typeof payload.end_date !== 'string'
        || payload.end_date.trim() === ''
        || (payload.reason !== undefined
          && payload.reason !== null
          && (typeof payload.reason !== 'string' || payload.reason.length > 500))) {
      throw validationError();
    }
    const startDate = parseLeaveDate(payload.start_date);
    const endDate = parseLeaveDate(payload.end_date);

    let reason = '';
    if (payload.reason !== undefined && payload.reason !== null) {
      reason = payload.reason.trim();
    }

    const leave = await service.apply(req.principal.user.id, { startDate, endDate, reason });

    return sendSuccess(res, leaveCreated(leave), 201);
  });

  router.patch(
    '/:leaveId/status',
    auth.requireRoles('MANAGER', 'ADMIN'),
    async (req, res) => {
      const leaveId = uuidValue(req.params.leaveId);
      const payload = requireObject(req.body);
      const status = enumValue(payload.status, ACTION_STATUSES);
      let rejectionReason = null;
      if (payload.rejection_reason !== undefined && payload.rejection_reason !== null) {
        if (typeof payload.rejection_reason !== 'string') throw validationError();
        rejectionReason = payload.rejection_reason.trim() || null;
      }
      const leave = await service.updateStatus(req.principal.user, leaveId, { status, rejectionReason });

      return sendSuccess(res, {
        id: leave.id,
        status: titleCaseStatus(leave.status),
        updated_at: leave.updatedAt,
        message: `Leave application status updated to ${leave.status}`,
      });
    },
  );

  router.get('/:leaveId', auth.requireRoles('EMPLOYEE', 'MANAGER', 'ADMIN'), async (req, res) => {
    const leaveId = uuidValue(req.params.leaveId);
    const leave = await service.get(req.principal.user, leaveId);
    return sendSuccess(res, leaveDetail(leave));
  });

  return router;
}
