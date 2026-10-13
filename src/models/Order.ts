import mongoose, { Schema, Document } from 'mongoose';
import { DELIVERY_AREAS, DISTRICTS, type DeliveryArea } from '../services/deliveryFees';

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

// The parcel booked with the courier. Filled by the Steadfast booking route;
// bookingStartedAt is a short lock so two clicks can't book the same order twice.
export interface IOrderCourier {
  name?: 'Steadfast';
  consignmentId?: number;
  trackingCode?: string;
  // The courier's own delivery status, e.g. in_review, pending, hold, delivered, cancelled
  status?: string;
  bookedAt?: Date;
  statusCheckedAt?: Date;
  bookingStartedAt?: Date;
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
  // Missing on orders placed before delivery areas existed
  district?: string;
  deliveryArea: DeliveryArea;
  items: IOrderItem[];
  subtotal: number;
  // Taka off the items, agreed by an admin on a manual order (0 for website orders)
  discount: number;
  deliveryFee: number;
  total: number;
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled' | 'Returned';
  paymentMethod: string;
  notes?: string;
  courier?: IOrderCourier;
  // Why the order was cancelled or the parcel came back (set on Cancelled and Returned)
  cancelReason?: string;
  returnedAt?: Date;
  // Whether stock was put back when the parcel came back
  restocked?: boolean;
  // Where the order came from: the website checkout, or entered by an admin
  source: 'website' | 'facebook' | 'whatsapp' | 'phone' | 'other';
  // Email of the admin who entered a manual order
  createdBy?: string;
  // Admin-only (see PRIVATE_ORDER_FIELDS in routes/orders.ts): never shown to the customer
  internalNotes: IOrderNote[];
  statusHistory: IStatusChange[];
  editHistory: IDetailEdit[];
  createdAt: Date;
  updatedAt: Date;
}

const ORDER_STATUS_VALUES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Returned'];

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
    district: {
      type: String,
      enum: DISTRICTS
    },
    deliveryArea: {
      type: String,
      enum: DELIVERY_AREAS,
      default: 'inside_dhaka'
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
    courier: {
      type: new Schema<IOrderCourier>(
        {
          name: { type: String, enum: ['Steadfast'] },
          consignmentId: { type: Number },
          trackingCode: { type: String },
          status: { type: String },
          bookedAt: { type: Date },
          statusCheckedAt: { type: Date },
          bookingStartedAt: { type: Date }
        },
        { _id: false }
      ),
      default: undefined
    },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    returnedAt: { type: Date },
    restocked: { type: Boolean },
    source: {
      type: String,
      enum: ['website', 'facebook', 'whatsapp', 'phone', 'other'],
      default: 'website'
    },
    createdBy: {
      type: String
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
OrderSchema.index({ deliveryArea: 1 });
OrderSchema.index({ createdAt: -1 });
// "Changed since" lookups from the admin (GET /orders?updatedSince=)
OrderSchema.index({ updatedAt: 1 });

export default mongoose.model<IOrder>('Order', OrderSchema);
