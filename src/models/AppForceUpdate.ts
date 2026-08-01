import mongoose, { Document, Schema } from 'mongoose';

export interface IPlatformVersionConfig {
  /** Latest version available in store (e.g. 1.3.0) */
  latestVersion: string;
  /** App versions below this MUST update (e.g. 1.2.0) */
  minVersion: string;
  /** Master switch — when false, never force update for this platform */
  forceUpdateEnabled: boolean;
  storeUrl: string;
}

export interface IAppForceUpdate extends Document {
  android: IPlatformVersionConfig;
  ios: IPlatformVersionConfig;
  title: string;
  message: string;
  optionalUpdateTitle: string;
  optionalUpdateMessage: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformVersionSchema = new Schema<IPlatformVersionConfig>(
  {
    latestVersion: { type: String, default: '1.0.0' },
    minVersion: { type: String, default: '1.0.0' },
    forceUpdateEnabled: { type: Boolean, default: false },
    storeUrl: { type: String, default: '' },
  },
  { _id: false }
);

const AppForceUpdateSchema = new Schema<IAppForceUpdate>(
  {
    android: {
      type: PlatformVersionSchema,
      default: () => ({
        latestVersion: '1.0.0',
        minVersion: '1.0.0',
        forceUpdateEnabled: false,
        storeUrl: '',
      }),
    },
    ios: {
      type: PlatformVersionSchema,
      default: () => ({
        latestVersion: '1.0.0',
        minVersion: '1.0.0',
        forceUpdateEnabled: false,
        storeUrl: '',
      }),
    },
    title: { type: String, default: 'Update Required' },
    message: {
      type: String,
      default: 'A new version of the app is available. Please update to continue.',
    },
    optionalUpdateTitle: { type: String, default: 'Update Available' },
    optionalUpdateMessage: {
      type: String,
      default: 'A newer version is available. Update for the best experience.',
    },
  },
  { timestamps: true }
);

export const AppForceUpdateModel = mongoose.model<IAppForceUpdate>(
  'AppForceUpdate',
  AppForceUpdateSchema
);
