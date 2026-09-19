import 'dotenv/config';
import mongoose from 'mongoose';
import Product from './models/Product';

const sampleProducts = [
  {
    slug: 'red-cotton-saree',
    name: 'Red Cotton Saree',
    price: 1299,
    images: [
      'https://picsum.photos/seed/coovi-red-1/800/1200',
      'https://picsum.photos/seed/coovi-red-2/800/1200',
    ],
    category: 'Saree',
    size: 'Free Size',
    description: 'Beautiful red cotton saree with traditional border design. Perfect for casual and semi-formal occasions.',
    stock: 15,
    inStock: true,
  },
  {
    slug: 'blue-silk-saree',
    name: 'Blue Silk Saree',
    price: 2499,
    images: [
      'https://picsum.photos/seed/coovi-blue-1/800/1200',
      'https://picsum.photos/seed/coovi-blue-2/800/1200',
    ],
    category: 'Saree',
    size: 'Free Size',
    description: 'Elegant blue silk saree with intricate embroidery. Ideal for weddings and special events.',
    stock: 8,
    inStock: true,
  },
  {
    slug: 'green-georgette-saree',
    name: 'Green Georgette Saree',
    price: 1799,
    images: [
      'https://picsum.photos/seed/coovi-green-1/800/1200',
      'https://picsum.photos/seed/coovi-green-2/800/1200',
    ],
    category: 'Saree',
    size: 'Free Size',
    description: 'Lightweight green georgette saree with floral print. Comfortable and stylish.',
    stock: 12,
    inStock: true,
  },
  {
    slug: 'golden-kanjivaram-saree',
    name: 'Golden Kanjivaram Saree',
    price: 3999,
    images: [
      'https://picsum.photos/seed/coovi-golden-1/800/1200',
      'https://picsum.photos/seed/coovi-golden-2/800/1200',
    ],
    category: 'Saree',
    size: 'Free Size',
    description: 'Premium golden kanjivaram silk saree with traditional temple border. Handwoven masterpiece.',
    stock: 5,
    inStock: true,
  },
  {
    slug: 'black-chiffon-saree',
    name: 'Black Chiffon Saree',
    price: 1599,
    images: [
      'https://picsum.photos/seed/coovi-black-1/800/1200',
      'https://picsum.photos/seed/coovi-black-2/800/1200',
    ],
    category: 'Saree',
    size: 'Free Size',
    description: 'Classy black chiffon saree with sequin work. Perfect for evening parties and formal events.',
    stock: 10,
    inStock: true,
  },
];

const seed = async (): Promise<void> => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || '', { appName: 'coovi-api' });
    console.log('✅ Connected to MongoDB');

    await Product.deleteMany({});
    console.log('🗑️  Cleared existing products');

    const created = await Product.insertMany(sampleProducts);
    console.log(`🌱 Inserted ${created.length} products:`);
    created.forEach((p) => console.log(`   - ${p.name} (৳${p.price})`));

    await mongoose.disconnect();
    console.log('\n✅ Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
};

seed();
