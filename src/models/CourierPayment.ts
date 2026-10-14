import mongoose, { Schema, Document, Types } from 'mongoose';

// One line per parcel on the courier's payment statement
export interface ICourierPaymentLine {
  order: Types.ObjectId;
  orderNumber: string;
  // the order's total when the payment was recorded, to spot a short collection
  orderTotal: number;
  // cash the courier collected from the customer (0 for a returned parcel)
  collected: number;
  // everything the courier kept for this parcel: delivery, COD and return charges
  charge: number;
  // collected - charge; negative when a returned parcel only cost money
  net: number;
}

// A payout from a courier: the cash it collected for a batch of parcels, minus its charges.
// Entered by hand from the courier's statement; not tied to any courier API.
export interface ICourierPayment extends Document {
  courier: string;
  paidAt: Date;
  method?: string;
  reference?: string;
  lines: ICourierPaymentLine[];
  collectedTotal: number;
  chargeTotal: number;
  netTotal: number;
  // what actually arrived in the bank or bKash account
  amountReceived: number;
  // amountReceived - netTotal; anything other than 0 needs a look
  difference: number;
  notes?: string;
  recordedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const PAYMENT_METHODS = ['Bank transfer', 'bKash', 'Nagad', 'Cash', 'Other'] as const;

const CourierPaymentSchema = new Schema<ICourierPayment>(
  {
    courier: { type: String, required: true, trim: true, default: 'Steadfast' },
    paidAt: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS },
    reference: { type: String, trim: true },
    lines: {
      type: [{
        order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
        orderNumber: { type: String, required: true },
        orderTotal: { type: Number, required: true, min: 0 },
        collected: { type: Number, required: true, min: 0 },
        charge: { type: Number, required: true, min: 0 },
        net: { type: Number, required: true }
      }],
      validate: [(lines: unknown[]) => lines.length > 0, 'A payment needs at least one order']
    },
    collectedTotal: { type: Number, required: true, min: 0 },
    chargeTotal: { type: Number, required: true, min: 0 },
    netTotal: { type: Number, required: true },
    amountReceived: { type: Number, required: true },
    difference: { type: Number, required: true },
    notes: { type: String, trim: true },
    recordedBy: { type: String }
  },
  { timestamps: true }
);

// An order can be paid for only once. A unique multikey index enforces it across
// payments even when two admins record overlapping statements at the same moment.
CourierPaymentSchema.index({ 'lines.order': 1 }, { unique: true });
CourierPaymentSchema.index({ paidAt: -1 });

export default mongoose.model<ICourierPayment>('CourierPayment', CourierPaymentSchema);
