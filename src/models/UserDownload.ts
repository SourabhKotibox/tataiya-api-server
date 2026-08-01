import mongoose, { Schema, Document, Types } from 'mongoose';

export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'paused';

export interface IUserDownload extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie';
  profileId?: string | null;
  /** Selected quality key e.g. 720p / 1080p / auto */
  quality?: string | null;
  status: DownloadStatus;
  /** Client-reported download progress 0–100 */
  progress: number;
  fileSize?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserDownloadSchema = new Schema<IUserDownload>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentModelType: { type: String, enum: ['Movie'], required: true },
    profileId: { type: String, default: null, index: true },
    quality: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'downloading', 'completed', 'failed', 'paused'],
      default: 'pending',
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    fileSize: { type: Number, default: null },
  },
  { timestamps: true }
);

UserDownloadSchema.index({ userId: 1, contentId: 1 }, { unique: true });

export const UserDownloadModel = mongoose.model<IUserDownload>('UserDownload', UserDownloadSchema);
