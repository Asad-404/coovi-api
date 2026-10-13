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
  deliveryFee: number;
  total: number;
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled' | 'Returned';
  paymentMethod: string;
  notes?: string;
  // Why the order was cancelled or the parcel came back (set on Cancelled and Returned)
  cancelReason?: string;
  returnedAt?: Date;
  // Whether stock was put back when the parcel came back
  restocked?: boolean;
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
      enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Returned'],
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
    cancelReason: { type: String, trim: true, maxlength: 300 },
    returnedAt: { type: Date },
    restocked: { type: Boolean }
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
