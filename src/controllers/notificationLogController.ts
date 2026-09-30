import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotificationLogModel } from '../models/NotificationLog';

export const listNotificationLogs = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as {
      page?: string;
      limit?: string;
      type?: string;
    };
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '100', 10)));
    const typeFilter = query.type;

    const filter: any = {};
    if (typeFilter && typeFilter !== 'all') {
      filter.type = typeFilter;
    }

    const [notifications, total] = await Promise.all([
      NotificationLogModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      NotificationLogModel.countDocuments(filter),
    ]);

    return reply.send({
      success: true,
      data: notifications.map((n: any) => ({
        id: String(n._id),
        _id: String(n._id),
        type: n.type || 'broadcast',
        isHighlight: !!n.isHighlight,
        title: n.title,
        text: n.text,
        userName: n.userName || 'All users',
        userEmail: n.userEmail || '',
        createdAt: n.createdAt,
        updatedAt: n.updatedAt || n.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const getNotificationLogById = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { notificationId } = request.params as { notificationId: string };
    const notification = await NotificationLogModel.findById(notificationId).lean();

    if (!notification) {
      return reply.status(404).send({ success: false, error: 'Notification not found' });
    }

    return reply.send({
      success: true,
      data: {
        id: String(notification._id),
        _id: String(notification._id),
        type: notification.type || 'broadcast',
        isHighlight: !!notification.isHighlight,
        title: notification.title,
        text: notification.text,
        userName: notification.userName || 'All users',
        userEmail: notification.userEmail || '',
        createdAt: notification.createdAt,
        updatedAt: notification.updatedAt || notification.createdAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const createNotificationLog = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      type?: string;
      isHighlight?: boolean;
      title: string;
      text?: string;
      message?: string;
      body?: string;
      userName?: string;
      userEmail?: string;
    };

    const text = body.text || body.message || body.body || '';

    if (!body.title || !text) {
      return reply.status(400).send({ success: false, error: 'Title and message are required' });
    }

    const notification = await NotificationLogModel.create({
      type: body.type || 'broadcast',
      title: body.title,
      text,
      userName: body.userName || 'All users',
      userEmail: body.userEmail || '',
      isHighlight: body.isHighlight ?? true,
    });

    return reply.status(201).send({
      success: true,
      data: {
        id: String(notification._id),
        _id: String(notification._id),
        type: notification.type,
        isHighlight: notification.isHighlight,
        title: notification.title,
        text: notification.text,
        userName: notification.userName,
        userEmail: notification.userEmail,
        createdAt: notification.createdAt,
        updatedAt: notification.updatedAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const updateNotificationLog = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { notificationId } = request.params as { notificationId: string };
    const body = request.body as Record<string, any>;

    const updateData: any = {};
    if (body.title !== undefined) updateData.title = body.title;
    if (body.text !== undefined || body.message !== undefined || body.body !== undefined) {
      updateData.text = body.text ?? body.message ?? body.body;
    }
    if (body.type !== undefined) updateData.type = body.type;
    if (body.isHighlight !== undefined) updateData.isHighlight = body.isHighlight;
    if (body.userName !== undefined) updateData.userName = body.userName;
    if (body.userEmail !== undefined) updateData.userEmail = body.userEmail;

    const updated = await NotificationLogModel.findByIdAndUpdate(
      notificationId,
      { $set: updateData },
      { new: true }
    ).lean();

    if (!updated) {
      return reply.status(404).send({ success: false, error: 'Notification not found' });
    }

    return reply.send({
      success: true,
      data: {
        id: String(updated._id),
        _id: String(updated._id),
        type: updated.type,
        isHighlight: updated.isHighlight,
        title: updated.title,
        text: updated.text,
        userName: updated.userName,
        userEmail: updated.userEmail,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const deleteNotificationLog = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { notificationId } = request.params as { notificationId: string };
    const notification = await NotificationLogModel.findByIdAndDelete(notificationId);

    if (!notification) {
      return reply.status(404).send({ success: false, error: 'Notification not found' });
    }

    return reply.send({
      success: true,
      message: 'Notification deleted successfully',
    });
  } catch (error: any) {
    return reply.status(500).send({ success: false, error: error.message });
  }
};

export const bulkDeleteNotificationLogs = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const { ids } = request.body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ success: false, message: 'Invalid or empty ids array' });
    }

    const result = await NotificationLogModel.deleteMany({ _id: { $in: ids } });

    return reply.send({
      success: true,
      message: `${result.deletedCount} notifications deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error: any) {
    console.error('Error bulk deleting notifications:', error);
    return reply.status(500).send({ success: false, message: 'Internal server error', error: error.message });
  }
};
