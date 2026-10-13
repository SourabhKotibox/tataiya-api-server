import mongoose, { Schema, Document, Types } from 'mongoose';

export type VideoJobEntityType = 'mediaFile' | 'movie' | 'tvShow' | 'episode';
export type VideoJobStatus = 'queued' | 'processing' | 'uploading' | 'completed' | 'failed';

export interface IVideoProcessingJob extends Document {
  entityType: VideoJobEntityType;
  entityId: Types.ObjectId;
  sourceUrl: string;
  sourceKey?: string;
  transcodeRequired: boolean;
  hlsOnly: boolean;
  status: VideoJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  lastError?: string;
  temporaryBytes: number;
  uploadedBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

const VideoProcessingJobSchema = new Schema<IVideoProcessingJob>(
  {
    entityType: { type: String, enum: ['mediaFile', 'movie', 'tvShow', 'episode'], required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    sourceUrl: { type: String, required: true },
    sourceKey: String,
    transcodeRequired: { type: Boolean, default: true },
    hlsOnly: { type: Boolean, default: false },
    status: { type: String, enum: ['queued', 'processing', 'uploading', 'completed', 'failed'], default: 'queued', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    leaseOwner: String,
    leaseExpiresAt: { type: Date, index: true },
    startedAt: Date,
    completedAt: Date,
    lastError: String,
    temporaryBytes: { type: Number, default: 0 },
    uploadedBytes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

VideoProcessingJobSchema.index({ entityType: 1, entityId: 1 }, { unique: true });
VideoProcessingJobSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export const VideoProcessingJobModel = mongoose.model<IVideoProcessingJob>(
  'VideoProcessingJob',
  VideoProcessingJobSchema
);