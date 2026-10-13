import mongoose, { Schema, Document } from 'mongoose';

export interface IProduct extends Document {
  slug: string;
  name: string;
  nameBn?: string;
  description?: string;
  descriptionBn?: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  size?: string;
  category: string;
  stock: number;
  inStock: boolean;
  allowPreorder: boolean;
  preorderDays: number;
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    nameBn: {
      type: String,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    descriptionBn: {
      type: String,
      trim: true
    },
    price: {
      type: Number,
      required: true,
      min: 0
    },
    compareAtPrice: {
      type: Number,
      min: 0
    },
    images: [{
      type: String,
      required: true
    }],
    size: {
      type: String,
      trim: true
    },
    category: {
      type: String,
      required: true,
      default: 'Saree'
    },
    stock: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    inStock: {
      type: Boolean,
      default: true
    },
    // When stock runs out, a pre-order product can still be ordered: the saree is sourced for
    // that customer and ships in about preorderDays. Pre-ordered pieces never touch `stock`.
    allowPreorder: {
      type: Boolean,
      default: false
    },
    preorderDays: {
      type: Number,
      default: 15,
      min: 1,
      max: 90
    },
  },
  {
    timestamps: true
  }
);

// Index for search and sorting
ProductSchema.index({ name: 'text' });
ProductSchema.index({ price: 1 });
ProductSchema.index({ category: 1 });

export default mongoose.model<IProduct>('Product', ProductSchema);
