import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import Product from '../src/models/Product';
import Order from '../src/models/Order';
import { signUpload } from '../src/routes/uploads';
import { deleteProductPhotos, photoPublicId } from '../src/services/productPhotos';

const CLOUD = 'demo-cloud';
const SECRET = 'test-cloudinary-secret';
const photo = (name: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1712345678/coovi/products/${name}.jpg`;

let token = '';
const fetchMock = vi.fn();

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'testadmin@coovi.com', password: 'testpass123' });
  token = login.body.data.token;
});

beforeEach(async () => {
  await Product.deleteMany({});
  await Order.deleteMany({});
  process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
  process.env.CLOUDINARY_API_KEY = '123456789012345';
  process.env.CLOUDINARY_API_SECRET = SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const makeProduct = (slug: string, images: string[]) =>
  Product.create({ slug, name: slug, price: 1000, images, stock: 5 });

const destroyedIds = () => fetchMock.mock.calls.map(([, init]) => (init.body as URLSearchParams).get('public_id'));

describe('photoPublicId', () => {
  it('reads the public id of a photo in our folder', () => {
    expect(photoPublicId(photo('abc123'), CLOUD)).toBe('coovi/products/abc123');
    expect(photoPublicId(`https://res.cloudinary.com/${CLOUD}/image/upload/c_fill,w_300/v1/coovi/products/x.webp`, CLOUD)).toBe('coovi/products/x');
  });

  it('ignores photos that are not ours', () => {
    expect(photoPublicId('https://picsum.photos/seed/a/800/1200', CLOUD)).toBeNull();
    expect(photoPublicId(photo('abc').replace(CLOUD, 'other-cloud'), CLOUD)).toBeNull();
    expect(photoPublicId(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/other/abc.jpg`, CLOUD)).toBeNull();
    expect(photoPublicId('not a url', CLOUD)).toBeNull();
  });
});

describe('deleteProductPhotos', () => {
  it('sends a signed destroy request for each photo', async () => {
    const result = await deleteProductPhotos([photo('a'), photo('b'), photo('a')]);
    expect(result).toEqual({ deleted: 2, kept: 0, failed: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`);
    const body = init.body as URLSearchParams;
    expect(body.get('public_id')).toBe('coovi/products/a');
    expect(body.get('api_key')).toBe('123456789012345');
    expect(body.get('signature')).toBe(signUpload({ public_id: 'coovi/products/a', timestamp: Number(body.get('timestamp')) }, SECRET));
  });

  it('keeps photos used by another product or shown on an order', async () => {
    await makeProduct('other', [photo('shared')]);
    await Order.collection.insertOne({ orderNumber: 'ORD-1', items: [{ image: photo('ordered') }] });

    const result = await deleteProductPhotos([photo('shared'), photo('ordered'), photo('alone')]);
    expect(result).toEqual({ deleted: 1, kept: 2, failed: 0 });
    expect(destroyedIds()).toEqual(['coovi/products/alone']);
  });

  it('does nothing when Cloudinary is not set up', async () => {
    delete process.env.CLOUDINARY_API_SECRET;
    expect(await deleteProductPhotos([photo('a')])).toEqual({ deleted: 0, kept: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts failures instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"bad"}}', { status: 401 }));
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 'not found' }), { status: 200 }));
    expect(await deleteProductPhotos([photo('a'), photo('b'), photo('c')])).toEqual({ deleted: 1, kept: 0, failed: 2 });
  });
});

describe('DELETE /api/products/:id', () => {
  it('deletes the product photos from Cloudinary', async () => {
    const product = await makeProduct('gone', [photo('one'), photo('two'), 'https://picsum.photos/seed/x/800/1200']);
    const res = await request(app).delete(`/api/products/${product._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(destroyedIds()).toEqual(['coovi/products/one', 'coovi/products/two']);
  });

  it('still deletes the product when Cloudinary fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const product = await makeProduct('gone-anyway', [photo('one')]);
    const res = await request(app).delete(`/api/products/${product._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await Product.exists({ _id: product._id })).toBeNull();
  });
});
