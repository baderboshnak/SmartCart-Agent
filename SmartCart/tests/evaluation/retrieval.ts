import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CatalogRecord } from '@engine/engine-types.mjs';
import { buildCatalog, searchCatalog, tokenize } from '@engine/smartcart-search.mjs';
import { buildSearchFilter, findProducts, MAX_SEARCH_LIMIT, searchPhrases } from '@/lib/db/products.repository';
import { COLLECTIONS, collections } from '@/lib/db/mongodb';
import { INDEX_DEFINITIONS } from '@/lib/db/indexes';
import { ITEM_CANDIDATE_LIMIT } from '@/lib/shopping/search';
import { storeKeyOf, toProductDocument } from '@/lib/catalog/normalize';
import { errorMessage } from '@/lib/shared/errors';
import { catalogFixture, catalogFixtureSha256 } from '../helpers/fixtures';
import { evaluateCase, type EvaluationCase, type EvaluationSection } from './types';

type Scope = {
  title: string;
  terms: string[];
  positive: RegExp;
  exclude?: RegExp;
  ambiguous?: RegExp;
  brandProof?: RegExp;
  limit?: number;
  storeKeys?: string[];
  experiment?: boolean;
};
const twelveEggs = /^(?:12\s*ביצ(?:ים|י)|ביצ(?:ים|י)\s+.*(?<!\d)12(?!\d))/u;
const eggProducts = /אטריות|פסטה|אבקה|חלבון|שוקולד|הפתעה|חטיף/u;

const scopes: Scope[] = [
  { title: 'חלב 3%', terms: ['חלב'], positive: /(?:^|\s)חלב\s*.*(?:^|[^\d.])3\s*%/u, exclude: /שוקולד|אבקה|משקה|סמורס|טירמיסו|מרוכז|גבינה|תחליף|סויה|שוקו|מעדן|קרום|יוגורט/u },
  { title: 'חלב מרוכז ממותק', terms: ['חלב מרוכז'], positive: /חלב\s+מרוכז.*ממותק/u, exclude: /גלידה|שוקולד|ופל|חטיף/u,
    ambiguous: /שומן צמחי/u },
  { title: 'חלב בטעם סמורס', terms: ['חלב סמורס'], positive: /(?:משק[ה.]?\s*חלב|מ[.\/]חלב|חלב)\s*(?:ב?טעם\s*)?סמורס/u },
  { title: 'לחם ללא גלוטן', terms: ['לחם'], positive: /(?:לחם|כיכר).*(?:ללא גלוטן|נטול גלוטן|לל["״]ג)|(?:ללא גלוטן|נטול גלוטן).*(?:לחם|כיכר)/u, exclude: /פירורי|קרוטונים|קמח/u },
  { title: 'לחם פרוס', terms: ['לחם'], positive: /לחם.*(?:פרוס|פרוסות)|פרוסות.*לחם/u, exclude: /צנים|פירורי|פודינג|קרוטונים/u },
  { title: 'ביצים 12 יחידות', terms: ['ביצים'], positive: twelveEggs, exclude: eggProducts },
  { title: 'עגבניות טריות', terms: ['עגבניות'], positive: /^עגבני(?:ה|ת|ות)(?:$|\s+(?:שרי|אשכולות|מגי|ארוז|אורגני))/u,
    exclude: /רסק|מרוסק|חתוכ|קצוצ|מקולפ|מיובש|רוטב/u },
  { title: 'קפה טורקי עלית', terms: ['קפה טורקי'], positive: /קפה\s+(?:שחור\s+)?טורקי.*עלית|עלית.*קפה\s+(?:שחור\s+)?טורקי/u, exclude: /עוגה|חטיף|משקה מוכן/u },
  { title: 'שמן זית', terms: ['שמן זית'], positive: /^(?:שמן|ש[.])\s*זית|(?:כתית|מכתית).*שמן זית/u,
    exclude: /תרסיס|ספריי|להדלקת|נרות|בטעם|ממרח|זיתים.*שמן/u },
  { title: 'מוצרלה מגורדת', terms: ['מוצרלה'], positive: /(?:מוצרלה|מוצארלה).*(?:מגורד|פתיתי)|(?:מגורד|פתיתי).*(?:מוצרלה|מוצארלה)/u, exclude: /מקלונים|קרקר|חטיף/u },
  { title: 'קוקה קולה זירו', terms: ['קוקה קולה'], positive: /קולה.*(?:זירו|zero)|(?:זירו|zero).*(?:קוקה.?קולה|coca.?cola)/iu,
    brandProof: /קוקה.?קולה|coca.?cola/iu, exclude: /סירופ|ארטיק|חטיף|לימון|נטול קפאין|נמבר וואן/u },
  { title: 'טחינה גולמית', terms: ['טחינה'], positive: /טחינה\s+(?:גולמית|משומשום מלא)|טחינה.*(?:100% שומשום|טהורה)/u, exclude: /סלט|מוכנה|רוטב/u },
  { title: 'אורז בסמטי', terms: ['אורז'], positive: /אורז\s+(?:הודי\s+)?בסמטי|בסמטי.*אורז/u, exclude: /מנה|מוכן|שבבי/u },
  { title: 'שיבולת שועל', terms: ['שיבולת שועל'], positive: /^(?:ש[י]?בולת שועל|שבולת שועל|קוואקר|קואקר)|(?:פתיתי|פתית[.])\s*ש[י]?בולת שועל/u,
    exclude: /משקה|מופחת שומן|גרנולה|עוגיות|חטיף|קמח|לחם|שוקולד/u },
  { title: 'חלב 3% עם חלון של 8 תוצאות', terms: ['חלב'], positive: /(?:^|\s)חלב\s*.*(?:^|[^\d.])3\s*%/u,
    exclude: /שוקולד|אבקה|משקה|סמורס|טירמיסו|מרוכז|גבינה|תחליף|סויה|שוקו|מעדן|קרום|יוגורט/u, limit: 8 },
  { title: 'ביצים 12 יחידות ברמי לוי', terms: ['ביצים'], positive: twelveEggs,
    exclude: eggProducts, storeKeys: ['rami_levy:7290058140886:001:039'] }
];

const auditedLabels = [
  { scope: 'ביצים 12 יחידות', barcode: '7290001201596', relevance: 'relevant', evidence: 'Title identifies 12 fresh shell eggs.' },
  { scope: 'ביצים 12 יחידות', barcode: '7290002053101', relevance: 'irrelevant', evidence: '12 identifies the noodle variety. Package contains 200 g of egg noodles.' },
  { scope: 'שמן זית', barcode: '7290120341517', relevance: 'irrelevant', evidence: 'Title identifies candle-lighting oil.' },
  { scope: 'שיבולת שועל', barcode: '7394376621703', relevance: 'irrelevant', evidence: 'Title identifies a 1 L reduced-fat oat drink.' },
  { scope: 'חלב מרוכז ממותק', barcode: '4606599013320', relevance: 'uncertain', evidence: 'Title identifies a blend with vegetable fat.' }
] as const;

function relevance(scope: Scope, product: CatalogRecord) {
  if (scope.exclude?.test(product.name)) return 'irrelevant';
  if (scope.ambiguous?.test(product.name)) return 'uncertain';
  if (scope.positive.test(product.name) &&
    (!scope.brandProof || scope.brandProof.test(product.name + ' ' + (product.manufacturer?.name ?? '')))) return 'relevant';
  return 'unlabelled';
}

const aliasScenarios = [
  { title: 'ביצים 12 יחידות', aliases: ['ביצי'] },
  { title: 'עגבניות טריות', aliases: ['עגבניה', 'עגבנית'] },
  { title: 'קוקה קולה זירו', aliases: ['קולה זירו'] },
  { title: 'שיבולת שועל', aliases: ['שבולת שועל', 'קוואקר', 'קואקר'] }
].map(({ title, aliases }): Scope => {
  const original = scopes.find(scope => scope.title === title)!;
  return { ...original, title: title + ' — ניסוי מונחים חלופיים', terms: [...original.terms, ...aliases], experiment: true };
});

const summary = (product: CatalogRecord) => ({ id: product._id, name: product.name, store: product.storeId, priceIls: product.pricing.listedPriceIls });

async function getSnapshot() {
  const requested = process.env.SMARTCART_EVAL_CATALOG;
  const defaultPath = join(homedir(), 'SmartCart-backups', 'catalog', 'smartcart_products_DB(2).json');
  try {
    const raw = await readFile(requested ?? defaultPath);
    const rows = JSON.parse(raw.toString('utf8')) as CatalogRecord[];
    if (!Array.isArray(rows) || !rows.length) throw new Error('The catalog must contain offers.');
    return { records: rows, source: 'local retail snapshot', sha256: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (requested || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { records: catalogFixture, source: 'checked-in catalog fixture', sha256: catalogFixtureSha256 };
  }
}

function missReason(product: CatalogRecord, terms: string[], unboundedIds: Set<string>, mongo: boolean, truncated: boolean) {
  if (unboundedIds.has(product._id)) return mongo
    ? (truncated ? 'The reference search includes this offer. MongoDB filled the candidate window before returning this ID.'
      : 'The reference search includes this offer. Inspect the stored MongoDB tokens and query filters for this ID.')
    : 'The ID falls beyond the returned candidate window.';
  const label = tokenize(product.name);
  const required = terms.map(term => tokenize(term));
  const missing = required.map(words => words.filter(word => !label.some(actual => actual === word || (word.length >= 4 && actual.startsWith(word)))));
  return 'Catalog title tokens did not satisfy a search phrase. Missing tokens: ' + missing.map(words => words.join(', ')).join(' / ');
}

export async function runRetrieval(): Promise<EvaluationSection> {
  const { records, source, sha256 } = await getSnapshot();
  const catalog = buildCatalog(records);
  const uri = process.env.SMARTCART_EVAL_MONGO_URI;
  const originalMongoUri = process.env.MONGODB_URI;
  const helper = uri ? await import('../helpers/test-db') : undefined;
  let isolated: Awaited<ReturnType<NonNullable<typeof helper>['createTestDatabase']>> | undefined;
  let mongoError: string | undefined;
  if (uri && helper) {
    process.env.MONGODB_URI = uri;
    try {
      isolated = await helper.createTestDatabase();
      const meta = { sourceFile: 'offline-audit-snapshot', sourceSha256: sha256, now: new Date(0) };
      for (let index = 0; index < records.length; index += 1_000) {
        await collections.products(isolated.db).insertMany(records.slice(index, index + 1_000).map(product => toProductDocument(product, meta)));
      }
    } catch (error) { mongoError = errorMessage(error); }
  }
  const cases: EvaluationCase[] = [];
  try {
    for (const [index, scope] of [...scopes, ...aliasScenarios].entries()) {
      cases.push(await evaluateCase({
        id: 'RET-' + String(index + 1).padStart(2, '0'), title: scope.title, request: scope.title,
        component: isolated && !mongoError ? 'MongoDB product retrieval' : 'reference catalog search',
        category: scope.experiment ? 'retrieval alias experiment' : 'retrieval',
        expected: 'Every individually labelled offer and the cheapest labelled offer are returned.'
      }, async () => {
        const inScope = (product: CatalogRecord) => !scope.storeKeys || scope.storeKeys.includes(storeKeyOf(product));
        const reference = records.filter(product => inScope(product) && relevance(scope, product) === 'relevant');
        const limit = scope.limit ?? ITEM_CANDIDATE_LIMIT;
        const start = performance.now();
        const fromRepository = isolated && !mongoError ? await findProducts(isolated.db, { terms: scope.terms, limit, storeKeys: scope.storeKeys }) : undefined;
        const referenceStart = performance.now();
        const unbounded = searchCatalog(catalog, { searchTerms: scope.terms }).results.filter(inScope);
        const candidates = fromRepository?.products ?? [...unbounded].sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit);
        const searchExecutionMs = fromRepository ? referenceStart - start : performance.now() - start;
        const mongoExplain = fromRepository && isolated ? await collections.products(isolated.db)
          .find(buildSearchFilter(searchPhrases(scope.terms), scope.storeKeys)).sort({ _id: 1 }).limit(limit).explain('executionStats') : undefined;
        const returned = new Set(candidates.map(product => product._id));
        const unboundedIds = new Set(unbounded.map(product => product._id));
        const truncated = fromRepository?.truncated ?? unbounded.length > candidates.length;
        const missed = reference.filter(product => !returned.has(product._id))
          .map(product => ({ ...summary(product), reason: missReason(product, scope.terms, unboundedIds, Boolean(fromRepository), truncated) }));
        const fixedByPrice = reference.filter(product => !product.package.isWeighted)
          .sort((a, b) => a.pricing.listedPriceIls - b.pricing.listedPriceIls);
        const cheapest = fixedByPrice[0];
        const cheapestReturned = fixedByPrice.find(product => returned.has(product._id));
        const cheapestRetrieved = cheapest ? cheapestReturned?.pricing.listedPriceIls === cheapest.pricing.listedPriceIls : null;
        const retrieved = reference.length - missed.length;
        const negative = candidates.filter(entry => relevance(scope, entry) === 'irrelevant');
        const uncertain = candidates.filter(entry => relevance(scope, entry) === 'uncertain');
        const unlabelled = candidates.filter(entry => relevance(scope, entry) === 'unlabelled');
        const perStore = Object.fromEntries([...new Set(candidates.map(storeKeyOf))].map(key => [key, candidates.filter(row => storeKeyOf(row) === key).length]));
        return {
          status: !reference.length ? 'skip' : missed.length ? 'fail' : 'pass',
          actual: { searchTerms: scope.terms, storeKeys: scope.storeKeys, limit,
            labelledOffers: reference.map(product => ({ ...summary(product), retrieved: returned.has(product._id) })), missed,
            cheapest: cheapest && summary(cheapest), cheapestReturned: cheapestReturned && summary(cheapestReturned), cheapestRetrieved,
            clearlyIrrelevantCandidates: negative.map(summary), uncertainCandidates: uncertain.map(summary), unlabelledCandidates: unlabelled.map(summary), perStore },
          metrics: {
            catalogOffersExamined: records.length, relevantOffers: reference.length, actualCandidates: candidates.length,
            relevantRetrieved: retrieved, falseNegatives: missed.length, confirmedFalsePositives: negative.length,
            uncertainCandidates: uncertain.length, unlabelledCandidates: unlabelled.length,
            recall: reference.length ? retrieved / reference.length : null,
            precisionLowerBound: candidates.length ? retrieved / candidates.length : null,
            precisionAmongLabelled: retrieved + negative.length ? retrieved / (retrieved + negative.length) : null,
            candidateReduction: 1 - candidates.length / records.length, truncated,
            realMongoQuery: Boolean(fromRepository), aliasExperiment: Boolean(scope.experiment), searchExecutionMs,
            mongoDocumentsExamined: mongoExplain?.executionStats?.totalDocsExamined,
            mongoIndexKeysExamined: mongoExplain?.executionStats?.totalKeysExamined
          }
        };
      }));
    }
  } finally {
    try {
      if (isolated) await isolated.cleanup();
    } finally {
      if (originalMongoUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = originalMongoUri;
    }
  }
  if (!isolated || mongoError) cases.push({
    id: 'RET-MONGO', title: 'Isolated MongoDB execution', category: 'retrieval infrastructure', status: uri ? 'fail' : 'skip',
    actual: mongoError ?? 'No isolated MongoDB URI supplied.'
  });
  const reviewed = auditedLabels.flatMap(label => {
    const scope = scopes.find(entry => entry.title === label.scope)!;
    return records.filter(product => product.productCode === label.barcode)
      .map(product => ({ ...label, ...summary(product), classifiedAs: relevance(scope, product) }));
  });
  cases.push({
    id: 'RET-LABELS', title: 'Verify snapshot classification against manually audited barcodes', category: 'retrieval ground truth',
    component: 'independent catalog labels', status: !reviewed.length ? 'skip' : reviewed.some(row => row.relevance !== row.classifiedAs) ? 'fail' : 'pass',
    expected: auditedLabels, actual: reviewed
  });
  const ordinary = cases.filter(row => (row.actual as { limit?: number } | undefined)?.limit === ITEM_CANDIDATE_LIMIT && row.metrics && !row.metrics.aliasExperiment);
  const sum = (field: string) => ordinary.reduce((total, row) => total + Number(row.metrics?.[field] ?? 0), 0);
  const cheapest = ordinary.flatMap(row => {
    const status = (row.actual as { cheapestRetrieved?: boolean | null } | undefined)?.cheapestRetrieved;
    return typeof status === 'boolean' ? [status] : [];
  });
  return {
    name: 'Product retrieval', mode: 'DETERMINISTIC', cases,
    metrics: { source, snapshotSha256: sha256, offers: records.length, isolatedMongo: Boolean(isolated && !mongoError),
      productionLimitScopes: ordinary.length, labelledRelevant: sum('relevantOffers'), relevantRetrieved: sum('relevantRetrieved'),
      relevantMissed: sum('falseNegatives'), confirmedFalsePositives: sum('confirmedFalsePositives'),
      candidates: sum('actualCandidates'), uncertainCandidates: sum('uncertainCandidates'), unlabelledCandidates: sum('unlabelledCandidates'),
      recall: sum('relevantOffers') ? sum('relevantRetrieved') / sum('relevantOffers') : null,
      precisionLowerBound: sum('actualCandidates') ? sum('relevantRetrieved') / sum('actualCandidates') : null,
      cheapestEligibleScopes: cheapest.length, cheapestFound: cheapest.filter(Boolean).length,
      retrievalPolicy: {
        fields: ['product.name', 'searchTokens', 'storeKey'],
        terms: 'All tokens in a phrase; alternative phrases are ORed. Four or more characters also match token prefixes.',
        order: 'Ascending offer ID', defaultLimit: ITEM_CANDIDATE_LIMIT, repositoryMaximum: MAX_SEARCH_LIMIT,
        configuredIndexes: INDEX_DEFINITIONS.filter(index => index.collection === COLLECTIONS.products).map(index =>
          ({ name: index.options.name, key: index.key, purpose: index.purpose }))
      } },
    notes: [
      'An independent scan of catalog names supplies conservative relevance labels. Titles outside the positive rules may still be relevant, so precision is reported as a lower bound.',
      'Each metric is scoped to this snapshot and labelled request. Offline reference search estimates candidate behavior and does not establish actual MongoDB results or latency.',
      'Cheapest is the minimum listed fixed-package price in the labelled set. The report identifies both a cheapest catalog offer and the cheapest returned offer. Tied offers satisfy the price check. Package sizes, weighting and checkout quantities can change the basket winner.',
      'Alias experiments and the deliberately small candidate window are measured separately from production-limit baseline totals.'
    ]
  };
}
