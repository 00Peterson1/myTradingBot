import { z } from 'zod';
import { contentHash } from '../../research/experiments/ExperimentRegistry.js';

export const cTraderIdSchema = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]).transform(String);
const lightSymbol = z.object({ symbolId: cTraderIdSchema, symbolName: z.string().min(1).optional(), enabled: z.boolean().optional(),
  symbolCategoryId: cTraderIdSchema.optional(), baseAssetId: cTraderIdSchema.optional(), quoteAssetId: cTraderIdSchema.optional(), description: z.string().optional() });
export const cTraderCatalogueSchema = z.object({ version: z.literal(1), provider: z.literal('CTRADER'), environment: z.literal('DEMO'),
  accountId: cTraderIdSchema, capturedAt: z.string().datetime(),
  symbols: z.array(lightSymbol).min(1),
  categories: z.array(z.object({ id: cTraderIdSchema, assetClassId: cTraderIdSchema, name: z.string().min(1) })),
  assetClasses: z.array(z.object({ id: cTraderIdSchema, name: z.string().min(1) })),
  archivedSymbols: z.array(z.object({ symbolId: cTraderIdSchema, name: z.string().min(1) })),
}).strict().superRefine((catalogue, ctx) => {
  for (const [label, ids] of [
    ['symbol', [...catalogue.symbols, ...catalogue.archivedSymbols].map(row => row.symbolId)],
    ['category', catalogue.categories.map(row => row.id)], ['asset class', catalogue.assetClasses.map(row => row.id)],
  ] as const) if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Duplicate cTrader ${label} identity` });
  const names = catalogue.symbols.flatMap(row => row.symbolName ? [row.symbolName] : []);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate cTrader symbol name requires explicit identity disambiguation' });
});
export type CTraderCatalogue = z.infer<typeof cTraderCatalogueSchema>;
export const cfdCatalogueCategorySchema = z.enum(['forex', 'metals', 'commodities', 'crypto', 'stock_indices', 'stocks', 'synthetic', 'unknown']);
export type CatalogueCategory = z.infer<typeof cfdCatalogueCategorySchema>;
const categories: Record<string, CatalogueCategory> = {
  forex: 'forex', fx: 'forex', currencies: 'forex', 'foreign exchange': 'forex',
  metals: 'metals', 'precious metals': 'metals', commodities: 'commodities', energies: 'commodities', energy: 'commodities',
  crypto: 'crypto', cryptocurrency: 'crypto', cryptocurrencies: 'crypto',
  indices: 'stock_indices', 'stock indices': 'stock_indices', 'stock index': 'stock_indices', 'equity indices': 'stock_indices',
  stocks: 'stocks', equities: 'stocks', shares: 'stocks', etfs: 'stocks',
  'equities eu': 'stocks', 'equities us': 'stocks', 'equities adx': 'stocks', 'etfs us': 'stocks',
  'soft commodities': 'commodities',
};
function classify(categoryName: string, assetClass: string): CatalogueCategory {
  const leaf = categoryName.toLowerCase().trim(), parent = assetClass.toLowerCase().trim();
  if (/\b(?:synthetic|synthetics|derived|tactical|volatility|boom|crash|jump|step|dex|range break)\b/i.test(`${leaf} ${parent}`)) return 'synthetic';
  return categories[leaf] ?? categories[parent] ?? 'unknown';
}
export interface CatalogueResearchEntry {
  symbol: string; brokerSymbolId: string; category: CatalogueCategory;
  catalogueStatus: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' | 'REVIEW_REQUIRED';
  dataset: string | null; config: string | null;
}
/** Every broker entry survives discovery; unresolved classifications never become executable defaults. */
export function catalogueResearchEntries(input: CTraderCatalogue): CatalogueResearchEntry[] {
  const catalogue = cTraderCatalogueSchema.parse(input);
  const classes = new Map(catalogue.assetClasses.map(row => [row.id, row.name]));
  const groups = new Map(catalogue.categories.map(row => [row.id, row]));
  const active: CatalogueResearchEntry[] = catalogue.symbols.map(row => {
    const group = row.symbolCategoryId ? groups.get(row.symbolCategoryId) : undefined;
    const parent = group ? classes.get(group.assetClassId) : undefined;
    const category = group && parent ? classify(group.name, parent) : 'unknown';
    return { symbol: row.symbolName ?? `UNNAMED_CTRADER_ID_${row.symbolId}`, brokerSymbolId: row.symbolId, category,
      catalogueStatus: row.enabled === false ? 'DISABLED' : row.enabled === true && row.symbolName && category !== 'unknown' ? 'ACTIVE' : 'REVIEW_REQUIRED',
      dataset: null, config: null };
  });
  return [...active, ...catalogue.archivedSymbols.map(row => ({ symbol: row.name, brokerSymbolId: row.symbolId, category: 'unknown' as const,
    catalogueStatus: 'ARCHIVED' as const, dataset: null, config: null }))];
}
export function catalogueIdentity(catalogue: CTraderCatalogue): string { return contentHash(cTraderCatalogueSchema.parse(catalogue)); }
