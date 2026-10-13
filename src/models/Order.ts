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

// "by" is the admin's email, or 'customer' for the order being placed.
// byId is the admin's id, kept so a later email change can't hide who it was.
export interface IOrderNote {
  text: string;
  by: string;
  byId?: string;
  at: Date;
}

export interface IStatusChange {
  from?: IOrder['status'];
  to: IOrder['status'];
  by: string;
  byId?: string;
  at: Date;
}

export interface IDetailEdit {
  changes: { field: string; from?: string; to?: string }[];
  by: string;
  byId?: string;
  at: Date;
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
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';
  paymentMethod: string;
  notes?: string;
  // Admin-only (see PRIVATE_ORDER_FIELDS in routes/orders.ts): never shown to the customer
  internalNotes: IOrderNote[];
  statusHistory: IStatusChange[];
  editHistory: IDetailEdit[];
  createdAt: Date;
  updatedAt: Date;
}

const ORDER_STATUS_VALUES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

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
    // Append-only: no route edits or deletes these, so the record can be trusted.
    // Orders placed before this existed simply have empty arrays.
    internalNotes: {
      type: [{
        text: { type: String, required: true, trim: true, maxlength: 500 },
        by: { type: String, required: true },
        byId: { type: String },
        at: { type: Date, required: true, default: Date.now }
      }],
      default: []
    },
    statusHistory: {
      type: [{
        from: { type: String, enum: ORDER_STATUS_VALUES },
        to: { type: String, enum: ORDER_STATUS_VALUES, required: true },
        by: { type: String, required: true },
        byId: { type: String },
        at: { type: Date, required: true, default: Date.now }
      }],
      default: []
    },
    editHistory: {
      type: [{
        changes: [{
          _id: false,
          field: { type: String, required: true },
          from: { type: String },
          to: { type: String }
        }],
        by: { type: String, required: true },
        byId: { type: String },
        at: { type: Date, required: true, default: Date.now }
      }],
      default: []
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

export default mongoose.model<IOrder>('Order', OrderSchema);
