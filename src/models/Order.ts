import mongoose, { Schema, Document } from 'mongoose';

export interface IOrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  image: string;
  size?: string;
  // true when this line is made or sourced to order: no stock is taken or returned for it
  preorder?: boolean;
  preorderDays?: number;
}

export interface IOrder extends Document {
  orderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  items: IOrderItem[];
  subtotal: number;
  // Taka off the items, agreed by an admin on a manual order (0 for website orders)
  discount: number;
  deliveryFee: number;
  total: number;
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';
  paymentMethod: string;
  notes?: string;
  // Where the order came from: the website checkout, or entered by an admin
  source: 'website' | 'facebook' | 'whatsapp' | 'phone' | 'other';
  // Email of the admin who entered a manual order
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true
    },
    customerName: {
      type: String,
      required: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true
    },
    address: {
      type: String,
      required: true,
      trim: true
    },
    items: [{
      productId: { type: String, required: true },
      name: { type: String, required: true },
      price: { type: Number, required: true },
      quantity: { type: Number, required: true, min: 1 },
      image: { type: String, required: true },
      size: { type: String },
      preorder: { type: Boolean, default: false },
      preorderDays: { type: Number, min: 1 }
    }],
    subtotal: {
      type: Number,
      required: true,
      min: 0
    },
    discount: {
      type: Number,
      default: 0,
      min: 0
    },
    deliveryFee: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    total: {
      type: Number,
      required: true,
      min: 0
    },
    status: {
      type: String,
      enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'],
      default: 'Pending'
    },
    paymentMethod: {
      type: String,
      required: true,
      default: 'Cash on Delivery'
    },
    notes: {
      type: String,
      trim: true
    },
    source: {
      type: String,
      enum: ['website', 'facebook', 'whatsapp', 'phone', 'other'],
      default: 'website'
    },
    createdBy: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

// Index for order lookup
OrderSchema.index({ phone: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ createdAt: -1 });
// "Changed since" lookups from the admin (GET /orders?updatedSince=)
OrderSchema.index({ updatedAt: 1 });

export default mongoose.model<IOrder>('Order', OrderSchema);
