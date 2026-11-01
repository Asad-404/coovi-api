import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';

const TEST_ADMIN = { email: 'testadmin@coovi.com', password: 'testpass123' };

const VALID_PRODUCT = {
  slug: 'test-saree',
  name: 'Test Saree',
  price: 999,
  images: [
    'https://picsum.photos/seed/test/800/1200',
    'https://picsum.photos/seed/test2/800/1200',
    'https://picsum.photos/seed/test3/800/1200',
  ],
  shareImage: 'https://picsum.photos/seed/test-share/1200/630',
  category: 'Saree',
  stock: 5,
  inStock: true,
};

async function getAdminToken(): Promise<string> {
  const login = await request(app).post('/api/auth/login').send(TEST_ADMIN);
  return login.body.data.token as string;
}

describe('GET /api/products (query validation)', () => {
  beforeAll(async () => {
    await Product.deleteMany({});
    await Product.create(VALID_PRODUCT);
  });

  it('returns 200 with the seeded product', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Test Saree');
    expect(res.body.data[0].price).toBe(999);
  });

  it('reports pagination metadata', async () => {
    const res = await request(app).get('/api/products?page=1&limit=12');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 12, total: 1 });
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('does not crash on regex metacharacters in search (was a 500)', async () => {
    const res = await request(app).get('/api/products?search=(');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('clamps a negative page to 1 (was a 500)', async () => {
    const res = await request(app).get('/api/products?page=-1');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
  });

  it('clamps an oversized limit to 50', async () => {
    const res = await request(app).get('/api/products?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });
});

describe('POST /api/products (body validation)', () => {
  it('rejects an invalid body with 400, not 500', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No slug, no price' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('rejects unexpected fields (mass assignment)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'brand-new-saree', _id: '000000000000000000000000' });
    expect(res.status).toBe(400);
  });

  it('rejects a price of 0', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'free-saree', price: 0 });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/price/);
  });

  it('rejects a malformed slug', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'My Saree!' });
    expect(res.status).toBe(400);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'http://example.com/saree.jpg'])(
    'rejects a non-https image address (%s)',
    async (image) => {
      const token = await getAdminToken();
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...VALID_PRODUCT, slug: 'bad-image-saree', images: [image] });
      expect(res.status).toBe(400);
      expect(res.body.errors.join(' ')).toMatch(/images/);
    }
  );

  it('creates a product for a valid body + token', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'another-test-saree' });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('another-test-saree');
    expect(res.body.data._id).toBeDefined();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/products').send(VALID_PRODUCT);
    expect(res.status).toBe(401);
  });
});

describe('share image (social media previews)', () => {
  it('saves a share image and returns it on the public product', async () => {
    const token = await getAdminToken();
    const shareImage = 'https://picsum.photos/seed/share/1200/630';
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'share-saree', shareImage });
    expect(created.status).toBe(201);
    expect(created.body.data.shareImage).toBe(shareImage);

    const res = await request(app).get('/api/products/share-saree');
    expect(res.status).toBe(200);
    expect(res.body.data.shareImage).toBe(shareImage);
  });

  it('rejects a share image that is not an https address', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'bad-share-saree', shareImage: 'http://example.com/a.jpg' });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/shareImage/);
  });
});

describe('PUT /api/products/:id (body validation)', () => {
  it('rejects an invalid body with 400', async () => {
    const token = await getAdminToken();
    const product = await Product.findOne({ slug: 'test-saree' });
    const res = await request(app)
      .put(`/api/products/${product!._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('sale pricing (compareAtPrice)', () => {
  const SALE_BODY = { ...VALID_PRODUCT, slug: 'sale-saree', name: 'Sale Saree', price: 1500, compareAtPrice: 2000 };

  it('creates a discounted product and lists it under onSale=true only', async () => {
    const token = await getAdminToken();
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send(SALE_BODY);
    expect(created.status).toBe(201);
    expect(created.body.data.compareAtPrice).toBe(2000);

    const onSale = await request(app).get('/api/products?onSale=true');
    expect(onSale.status).toBe(200);
    expect(onSale.body.data.map((p: { slug: string }) => p.slug)).toEqual(['sale-saree']);

    const all = await request(app).get('/api/products?limit=50');
    expect(all.body.data.length).toBeGreaterThan(1);
  });

  it('rejects an original price that is not higher than the price', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...SALE_BODY, slug: 'bad-sale-saree', compareAtPrice: 1500 });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/compareAtPrice/);
  });

  it('removes the discount when compareAtPrice is sent as null', async () => {
    const token = await getAdminToken();
    const product = await Product.findOne({ slug: 'sale-saree' });
    const res = await request(app)
      .put(`/api/products/${product!._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...SALE_BODY, compareAtPrice: null });
    expect(res.status).toBe(200);
    expect(res.body.data.compareAtPrice).toBeUndefined();

    const onSale = await request(app).get('/api/products?onSale=true');
    expect(onSale.body.data).toHaveLength(0);
  });

  it('clears optional fields the admin form leaves empty on a full PUT', async () => {
    const token = await getAdminToken();
    const { shareImage: _shareImage, ...withoutShareImage } = VALID_PRODUCT;
    // A draft: a published product may not drop its share image
    const product = await Product.create({
      ...VALID_PRODUCT,
      published: false,
      slug: 'clear-fields-saree',
      nameBn: 'শাড়ি',
      description: 'Old description',
      size: 'Free Size',
      shareImage: 'https://picsum.photos/seed/share/1200/630',
    });
    const res = await request(app)
      .put(`/api/products/${product._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...withoutShareImage, slug: 'clear-fields-saree' });
    expect(res.status).toBe(200);
    expect(res.body.data.nameBn).toBeUndefined();
    expect(res.body.data.description).toBeUndefined();
    expect(res.body.data.size).toBeUndefined();
    expect(res.body.data.shareImage).toBeUndefined();
  });

  it('keeps the sale and pre-order settings when an update leaves them out', async () => {
    const token = await getAdminToken();
    const product = await Product.create({
      ...VALID_PRODUCT,
      slug: 'keep-settings-saree',
      category: 'Jamdani',
      inStock: false,
      allowPreorder: true,
      preorderDays: 20,
    });
    const { category, inStock, ...withoutSettings } = VALID_PRODUCT;
    void category;
    void inStock;
    const res = await request(app)
      .put(`/api/products/${product._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...withoutSettings, slug: 'keep-settings-saree', name: 'Renamed Saree' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed Saree');
    expect(res.body.data.category).toBe('Jamdani');
    expect(res.body.data.inStock).toBe(false);
    expect(res.body.data.allowPreorder).toBe(true);
    expect(res.body.data.preorderDays).toBe(20);
  });

  it('still changes the settings when an update sends them', async () => {
    const token = await getAdminToken();
    const product = await Product.create({ ...VALID_PRODUCT, slug: 'change-settings-saree', allowPreorder: true });
    const res = await request(app)
      .put(`/api/products/${product._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PRODUCT, slug: 'change-settings-saree', inStock: false, allowPreorder: false, preorderDays: 30 });
    expect(res.status).toBe(200);
    expect(res.body.data.inStock).toBe(false);
    expect(res.body.data.allowPreorder).toBe(false);
    expect(res.body.data.preorderDays).toBe(30);
  });

  it('still gives a new product the default settings', async () => {
    const token = await getAdminToken();
    const { category, inStock, ...withoutSettings } = VALID_PRODUCT;
    void category;
    void inStock;
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...withoutSettings, slug: 'default-settings-saree' });
    expect(res.status).toBe(201);
    expect(res.body.data.category).toBe('Saree');
    expect(res.body.data.inStock).toBe(true);
    expect(res.body.data.allowPreorder).toBe(false);
    expect(res.body.data.preorderDays).toBe(15);
  });

  it('still charges the current price in orders, not the original price', async () => {
    const product = await Product.create({ ...VALID_PRODUCT, slug: 'order-sale-saree', price: 1200, compareAtPrice: 1800 });
    const res = await request(app)
      .post('/api/orders')
      .send({
        customerName: 'Sale Buyer',
        phone: '01712345678',
        address: 'House 1, Road 2, Dhaka',
        items: [{ productId: String(product._id), quantity: 2 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.subtotal).toBe(2400);
  });
});

describe('publishing products', () => {
  const auth = async () => ({ Authorization: `Bearer ${await getAdminToken()}` });

  it('hides a draft from the public list and product page, but not from the admin', async () => {
    await Product.deleteMany({});
    await Product.create({ ...VALID_PRODUCT, slug: 'live-saree' });
    const created = await request(app)
      .post('/api/products')
      .set(await auth())
      .send({ ...VALID_PRODUCT, slug: 'draft-saree', published: false });
    expect(created.status).toBe(201);
    expect(created.body.data.published).toBe(false);

    const list = await request(app).get('/api/products');
    expect(list.body.data.map((p: { slug: string }) => p.slug)).toEqual(['live-saree']);
    expect(list.body.pagination.total).toBe(1);
    expect((await request(app).get('/api/products/draft-saree')).status).toBe(404);

    const managed = await request(app).get('/api/products/manage').set(await auth());
    expect(managed.status).toBe(200);
    expect(managed.body.data.map((p: { slug: string }) => p.slug).sort()).toEqual(['draft-saree', 'live-saree']);
    expect(managed.body.pagination.total).toBe(2);

    const one = await request(app).get('/api/products/manage/draft-saree').set(await auth());
    expect(one.status).toBe(200);
    expect(one.body.data.published).toBe(false);
  });

  it('keeps the admin routes behind a sign-in', async () => {
    expect((await request(app).get('/api/products/manage')).status).toBe(401);
    expect((await request(app).get('/api/products/manage/draft-saree')).status).toBe(401);
  });

  it('answers 404 on the admin route for an unknown slug', async () => {
    const res = await request(app).get('/api/products/manage/no-such-saree').set(await auth());
    expect(res.status).toBe(404);
  });

  it('publishes and unpublishes a product, and keeps the state when an update leaves it out', async () => {
    const product = await Product.create({ ...VALID_PRODUCT, slug: 'toggle-saree', published: false });
    const put = async (body: object) =>
      request(app).put(`/api/products/${product._id}`).set(await auth()).send({ ...VALID_PRODUCT, slug: 'toggle-saree', ...body });

    expect((await put({})).body.data.published).toBe(false);

    expect((await put({ published: true })).body.data.published).toBe(true);
    expect((await request(app).get('/api/products/toggle-saree')).status).toBe(200);

    expect((await put({ published: false })).body.data.published).toBe(false);
    expect((await request(app).get('/api/products/toggle-saree')).status).toBe(404);
  });

  it('publishes a new product when the request does not say', async () => {
    const res = await request(app)
      .post('/api/products')
      .set(await auth())
      .send({ ...VALID_PRODUCT, slug: 'default-published-saree' });
    expect(res.body.data.published).toBe(true);
  });

  it('keeps products saved before the field existed on the shop', async () => {
    await Product.collection.insertOne({ ...VALID_PRODUCT, slug: 'old-saree' });
    const res = await request(app).get('/api/products/old-saree');
    expect(res.status).toBe(200);
    expect(res.body.data.published).toBe(true);
    const list = await request(app).get('/api/products?search=Test&limit=50');
    expect(list.body.data.map((p: { slug: string }) => p.slug)).toContain('old-saree');
  });

  it('refuses to order a draft', async () => {
    const draft = await Product.create({ ...VALID_PRODUCT, slug: 'unorderable-saree', published: false });
    const res = await request(app)
      .post('/api/orders')
      .send({
        customerName: 'Draft Buyer',
        phone: '01712345679',
        address: 'House 1, Road 2, Dhaka',
        items: [{ productId: String(draft._id), quantity: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('currently unavailable');
  });

  it('still takes an order for a product saved before the field existed', async () => {
    const { insertedId } = await Product.collection.insertOne({ ...VALID_PRODUCT, slug: 'old-orderable-saree' });
    const res = await request(app)
      .post('/api/orders')
      .send({
        customerName: 'Old Buyer',
        phone: '01712345680',
        address: 'House 1, Road 2, Dhaka',
        items: [{ productId: String(insertedId), quantity: 1 }],
      });
    expect(res.status).toBe(201);
  });

  it('refuses the reserved web address "manage"', async () => {
    const res = await request(app)
      .post('/api/products')
      .set(await auth())
      .send({ ...VALID_PRODUCT, slug: 'manage' });
    expect(res.status).toBe(400);
  });
});

describe('what a product needs to be published', () => {
  const auth = async () => ({ Authorization: `Bearer ${await getAdminToken()}` });
  const ONE_PHOTO = [VALID_PRODUCT.images[0]];
  const { shareImage: _shareImage, ...NO_SHARE_IMAGE } = VALID_PRODUCT;

  const post = async (body: object) => request(app).post('/api/products').set(await auth()).send(body);
  const put = async (id: unknown, body: object) => request(app).put(`/api/products/${id}`).set(await auth()).send(body);

  it('refuses to publish a new product with fewer than 3 photos', async () => {
    const res = await post({ ...VALID_PRODUCT, slug: 'few-photos', images: VALID_PRODUCT.images.slice(0, 2) });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at least 3');
  });

  it('does not count the same photo twice', async () => {
    const res = await post({ ...VALID_PRODUCT, slug: 'same-photo', images: [ONE_PHOTO[0], ONE_PHOTO[0], ONE_PHOTO[0]] });
    expect(res.status).toBe(400);
  });

  it('refuses to publish a new product with no share image', async () => {
    const res = await post({ ...NO_SHARE_IMAGE, slug: 'no-share' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('share image');
  });

  it('applies the rule when the request leaves published out, because that publishes it', async () => {
    const { published: _published, ...body } = { ...VALID_PRODUCT, slug: 'default-rule', images: ONE_PHOTO, published: true };
    expect((await post(body)).status).toBe(400);
  });

  it('lets a draft have one photo and no share image', async () => {
    const res = await post({ ...NO_SHARE_IMAGE, slug: 'thin-draft', images: ONE_PHOTO, published: false });
    expect(res.status).toBe(201);
  });

  it('refuses to publish that draft until it has them', async () => {
    const draft = await Product.create({ ...NO_SHARE_IMAGE, slug: 'thin-draft-2', images: ONE_PHOTO, published: false });
    const body = { ...NO_SHARE_IMAGE, slug: 'thin-draft-2', images: ONE_PHOTO };

    expect((await put(draft._id, { ...body, published: true })).status).toBe(400);
    expect((await Product.findById(draft._id))?.published).toBe(false);

    expect((await put(draft._id, { ...VALID_PRODUCT, slug: 'thin-draft-2', published: true })).status).toBe(200);
  });

  it('lets an older published product change its stock without new photos', async () => {
    const old = await Product.create({ ...NO_SHARE_IMAGE, slug: 'old-thin', images: ONE_PHOTO });
    const res = await put(old._id, { ...NO_SHARE_IMAGE, slug: 'old-thin', images: ONE_PHOTO, stock: 9 });
    expect(res.status).toBe(200);
    expect(res.body.data.stock).toBe(9);
  });

  it('refuses a change of pictures that leaves a published product short', async () => {
    const live = await Product.create({ ...VALID_PRODUCT, slug: 'live-full' });
    const body = { ...VALID_PRODUCT, slug: 'live-full' };

    expect((await put(live._id, { ...body, images: ONE_PHOTO })).status).toBe(400);
    expect((await put(live._id, NO_SHARE_IMAGE)).status).toBe(400);
  });

  it('lets a published product be unpublished whatever it has', async () => {
    const old = await Product.create({ ...NO_SHARE_IMAGE, slug: 'old-thin-2', images: ONE_PHOTO });
    const res = await put(old._id, { ...NO_SHARE_IMAGE, slug: 'old-thin-2', images: ONE_PHOTO, published: false });
    expect(res.status).toBe(200);
  });

  it('answers 404 for a product that does not exist', async () => {
    expect((await put('000000000000000000000000', VALID_PRODUCT)).status).toBe(404);
  });
});
