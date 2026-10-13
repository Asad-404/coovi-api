// Delivery is charged by area: one fee inside Dhaka city, another for the rest
// of the country (Dhaka suburbs such as Savar and Keraniganj count as outside,
// as couriers like Steadfast charge them more). The customer only says WHERE
// the parcel goes; the amount always comes from here (CC-1, CC-3).

export const DELIVERY_AREAS = ['inside_dhaka', 'outside_dhaka'] as const;
export type DeliveryArea = (typeof DELIVERY_AREAS)[number];
export type DeliveryFees = Record<DeliveryArea, number>;

// The 64 districts of Bangladesh, in the English spelling couriers use
export const DISTRICTS = [
  'Bagerhat', 'Bandarban', 'Barguna', 'Barishal', 'Bhola', 'Bogura', 'Brahmanbaria', 'Chandpur',
  'Chapai Nawabganj', 'Chattogram', 'Chuadanga', "Cox's Bazar", 'Cumilla', 'Dhaka', 'Dinajpur', 'Faridpur',
  'Feni', 'Gaibandha', 'Gazipur', 'Gopalganj', 'Habiganj', 'Jamalpur', 'Jashore', 'Jhalokathi',
  'Jhenaidah', 'Joypurhat', 'Khagrachhari', 'Khulna', 'Kishoreganj', 'Kurigram', 'Kushtia', 'Lakshmipur',
  'Lalmonirhat', 'Madaripur', 'Magura', 'Manikganj', 'Meherpur', 'Moulvibazar', 'Munshiganj', 'Mymensingh',
  'Naogaon', 'Narail', 'Narayanganj', 'Narsingdi', 'Natore', 'Netrokona', 'Nilphamari', 'Noakhali',
  'Pabna', 'Panchagarh', 'Patuakhali', 'Pirojpur', 'Rajbari', 'Rajshahi', 'Rangamati', 'Rangpur',
  'Satkhira', 'Shariatpur', 'Sherpur', 'Sirajganj', 'Sunamganj', 'Sylhet', 'Tangail', 'Thakurgaon'
] as const;
export type District = (typeof DISTRICTS)[number];

export const DEFAULT_DELIVERY_FEES: DeliveryFees = { inside_dhaka: 70, outside_dhaka: 130 };

const readFee = (...values: (string | undefined)[]): number | undefined => {
  for (const value of values) {
    if (value === undefined || value === '') continue;
    const fee = Number(value);
    if (Number.isFinite(fee) && fee >= 0) return fee;
  }
  return undefined;
};

// Read at call time so tests and deploys can change it. Async on purpose: the
// fees are meant to move into the admin's shop settings (a database read).
// DELIVERY_FEE is the old single flat fee, still honoured as the inside-Dhaka fee.
export async function getDeliveryFees(): Promise<DeliveryFees> {
  return {
    inside_dhaka:
      readFee(process.env.DELIVERY_FEE_INSIDE_DHAKA, process.env.DELIVERY_FEE) ?? DEFAULT_DELIVERY_FEES.inside_dhaka,
    outside_dhaka: readFee(process.env.DELIVERY_FEE_OUTSIDE_DHAKA) ?? DEFAULT_DELIVERY_FEES.outside_dhaka
  };
}

export async function getDeliveryFee(area: DeliveryArea): Promise<number> {
  return (await getDeliveryFees())[area];
}

// Only Dhaka district can be inside Dhaka. Returns the area to charge, or an
// error message when the two disagree. With no district (an older client),
// the area alone decides and defaults to inside Dhaka.
export function resolveDeliveryArea(
  district: string | undefined,
  area: DeliveryArea | undefined
): { area: DeliveryArea } | { error: string } {
  if (district && district !== 'Dhaka') {
    if (area === 'inside_dhaka') return { error: `inside_dhaka is only for district Dhaka, not ${district}` };
    return { area: 'outside_dhaka' };
  }
  return { area: area ?? 'inside_dhaka' };
}
