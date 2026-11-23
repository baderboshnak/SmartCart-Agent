import { countProducts } from '@/lib/db/products.repository';
import { getDb, pingDatabase } from '@/lib/db/mongodb';
import { findStores } from '@/lib/db/stores.repository';
import { errorResponse, json } from '@/lib/server/http';
import { geminiConfigured } from '@/lib/server/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Database connectivity and catalog status. Never includes credentials. */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    await pingDatabase(db);
    const [products, stores] = await Promise.all([countProducts(db), findStores(db)]);
    return json({
      ok: true,
      database: 'connected',
      products,
      stores: stores.map(store => ({ storeKey: store._id, name: store.displayName, products: store.productCount, snapshotDates: store.snapshotDates })),
      geminiConfigured: geminiConfigured()
    });
  } catch (error) {
    return errorResponse(error);
  }
}
