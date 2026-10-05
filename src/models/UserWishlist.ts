import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserWishlist extends Document {
  userId: Types.ObjectId;
  contentId: Types.ObjectId;
  contentModelType: 'Movie' | 'TVShow' | 'Episode'; // which collection contentId refers to
  profileId?: string | null; // OTT profile isolation (null = default/unscoped)
  createdAt: Date;
}

const UserWishlistSchema = new Schema<IUserWishlist>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentId: { type: Schema.Types.ObjectId, required: true, index: true },
    contentModelType: { type: String, enum: ['Movie', 'TVShow', 'Episode'], required: true },
    profileId: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

// Unique constraint: one wishlist item per user per content per profile
UserWishlistSchema.index({ userId: 1, contentId: 1, profileId: 1 }, { unique: true });

export const UserWishlistModel = mongoose.model<IUserWishlist>('UserWishlist', UserWishlistSchema);

// Safely drop obsolete { userId: 1, contentId: 1 } index if present in MongoDB
UserWishlistModel.on('index', async (err) => {
  if (err) return;
  try {
    const indexes = await UserWishlistModel.collection.indexes();
    const obsoleteIndex = indexes.find(
      (idx) => idx.name === 'userId_1_contentId_1' && Object.keys(idx.key || {}).length === 2
    );
    if (obsoleteIndex) {
      await UserWishlistModel.collection.dropIndex('userId_1_contentId_1');
    }
  } catch {
    // Ignore if collection not yet created or index does not exist
  }
});
