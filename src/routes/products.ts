import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import Product from '../models/Product';

const router = Router();

// Escapes regex metacharacters so a search like "(Cotton" matches the literal
// text instead of being parsed as a regex (which would crash Mongo with a 500)
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Query strings are validated LENIENTLY: bad values fall back to safe defaults
// (public URLs, old links, and search engines must never get a hard error)
const listQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).transform((v) => Math.max(1, v)),
  limit: z.coerce.number().int().catch(12).transform((v) => Math.min(Math.max(1, v), 50)),
  search: z.string().max(100).catch(''),
  sort: z.enum(['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc']).catch('newest'),
  category: z.string().max(50).catch(''),
});

// Request bodies are validated STRICTLY: anything unexpected is rejected
// (this is what stops clients from setting fields they shouldn't — mass assignment)
const productBodySchema = z.strictObject({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens'),
  name: z.string().min(1).max(120),
  nameBn: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  descriptionBn: z.string().max(2000).optional(),
  price: z.number().int().min(0),
  images: z.array(z.url()).min(1),
  size: z.string().max(50).optional(),
  category: z.string().min(1).max(50).default('Saree'),
  stock: z.number().int().min(0),
  inStock: z.boolean().default(true),
});

// GET /api/products - Get all products with pagination, search, and sort
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { page, limit, search, sort, category } = listQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;

    const query: { name?: { $regex: string; $options: string }; category?: string } = {};

    // Search by name (partial match, case-insensitive, regex-safe)
    if (search) {
      query.name = { $regex: escapeRegex(search), $options: 'i' };
    }

    if (category) {
      query.category = category;
    }

    const sortQuery: Record<string, 1 | -1> = {};
    switch (sort) {
      case 'price-asc':
        sortQuery.price = 1;
        break;
      case 'price-desc':
        sortQuery.price = -1;
        break;
      case 'name-asc':
        sortQuery.name = 1;
        break;
      case 'name-desc':
        sortQuery.name = -1;
        break;
      default:
        sortQuery.createdAt = -1;
        break;
    }

    const products = await Product.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .select('-__v');

    const total = await Product.countDocuments(query);

    res.json({
      success: true,
      data: products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: page * limit < total
      }
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// GET /api/products/:slug - Get single product by slug
router.get('/:slug', async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({ slug }).select('-__v');

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found'
      });
      return;
    }

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// POST /api/products - Create new product (Admin only - JWT required)
router.post('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = productBodySchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: 'Invalid product data',
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      });
      return;
    }

    const product = new Product(parsed.data);
    await product.save();

    res.status(201).json({
      success: true,
      data: product,
      message: 'Product created successfully'
    });
  } catch (error: any) {
    console.error('Error creating product:', error);

    if (error.code === 11000) {
      res.status(400).json({
        success: false,
        message: 'Product with this slug already exists'
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create product',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// PUT /api/products/:id - Update product (Admin only - JWT required)
router.put('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const parsed = productBodySchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: 'Invalid product data',
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      });
      return;
    }

    const product = await Product.findByIdAndUpdate(id, parsed.data, { new: true });

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found'
      });
      return;
    }

    res.json({
      success: true,
      data: product,
      message: 'Product updated successfully'
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// DELETE /api/products/:id - Delete product (Admin only - JWT required)
router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const product = await Product.findByIdAndDelete(id);

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

export default router;
