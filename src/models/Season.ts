import { adminAuditPlugin } from '../middlewares/adminAuditPlugin';
import { mediaLinkerPlugin } from '../middlewares/mediaLinkerPlugin';
import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISeason extends Document {
  tvShowId: Types.ObjectId;
  seasonNumber: number;
  title: string;
  description?: string;
  poster?: string;
  posterImage?: string;
  releaseDate?: Date | null;
  status: 'published' | 'draft';
  createdAt: Date;
  updatedAt: Date;
}

const SeasonSchema = new Schema<ISeason>(
  {
    tvShowId: { type: Schema.Types.ObjectId, ref: 'TVShow', required: true, index: true },
    seasonNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'Season number must be an integer' },
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    poster: String,
    posterImage: String,
    releaseDate: Date,
    status: { type: String, enum: ['published', 'draft'], default: 'published' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

SeasonSchema.index({ tvShowId: 1, seasonNumber: 1 }, { unique: true });

SeasonSchema.plugin(adminAuditPlugin);
SeasonSchema.plugin(mediaLinkerPlugin);

export const SeasonModel = mongoose.model<ISeason>('Season', SeasonSchema);