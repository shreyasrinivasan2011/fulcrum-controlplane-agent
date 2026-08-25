/* The vocabulary the model may propose in, and the code that checks it.
 *
 * The model never writes or runs code. It emits a declarative invariant —
 * an endpoint, a field path, a predicate from the fixed list below, and its
 * arguments — and this file executes it against live data. The worst a
 * hallucinating model can produce is a claim that fails verification and gets
 * recorded as rejected; it cannot produce an action.
 */

/** Resolve a dotted path, e.g. "metrics.runs_30d". */
export function at(object, path) {
  return path.split('.').reduce((value, key) =>
    (value === null || value === undefined ? undefined : value[key]), object);
}

const isMissing = (v) => v === undefined;
const isBlank = (v) => v === null || v === undefined;

/**
 * Each predicate takes the sampled items and the invariant, and returns the
 * items that break it. An empty list means the invariant held.
 *
 * `needsArgs` is validated before anything runs, so a malformed proposal is
 * thrown out without touching the API.
 */
export const PREDICATES = {
  always_present: {
    describe: (i) => `${i.field} is present on every row`,
    violations: (items, i) => items.filter(x => isMissing(at(x, i.field))),
  },
  never_null: {
    describe: (i) => `${i.field} is never null`,
    violations: (items, i) => items.filter(x => isBlank(at(x, i.field))),
  },
  type_is: {
    needsArgs: ['type'],
    describe: (i) => `${i.field} is always a ${i.args.type}`,
    violations: (items, i) => items.filter(x => {
      const v = at(x, i.field);
      if (isBlank(v)) return false;                       // nullability is its own predicate
      return i.args.type === 'array' ? !Array.isArray(v) : typeof v !== i.args.type;
    }),
  },
  enum_subset: {
    needsArgs: ['values'],
    describe: (i) => `${i.field} is one of ${i.args.values.join(', ')}`,
    violations: (items, i) => items.filter(x => {
      const v = at(x, i.field);
      return !isBlank(v) && !i.args.values.includes(v);
    }),
  },
  matches: {
    needsArgs: ['pattern'],
    describe: (i) => `${i.field} matches /${i.args.pattern}/`,
    violations: (items, i) => {
      const re = new RegExp(i.args.pattern);
      return items.filter(x => {
        const v = at(x, i.field);
        return !isBlank(v) && !re.test(String(v));
      });
    },
  },
  bounded: {
    needsArgs: ['min', 'max'],
    describe: (i) => `${i.field} sits between ${i.args.min} and ${i.args.max}`,
    violations: (items, i) => items.filter(x => {
      const v = at(x, i.field);
      return typeof v === 'number' && (v < i.args.min || v > i.args.max);
    }),
  },
  non_negative: {
    describe: (i) => `${i.field} is never negative`,
    violations: (items, i) => items.filter(x => {
      const v = at(x, i.field);
      return typeof v === 'number' && v < 0;
    }),
  },
  unique: {
    describe: (i) => `${i.field} is unique across the collection`,
    violations: (items, i) => {
      const seen = new Map();
      const dupes = [];
      for (const x of items) {
        const v = at(x, i.field);
        if (isBlank(v)) continue;
        if (seen.has(v)) dupes.push(x); else seen.set(v, x);
      }
      return dupes;
    },
  },
  iso_timestamp: {
    describe: (i) => `${i.field} parses as a timestamp`,
    violations: (items, i) => items.filter(x => {
      const v = at(x, i.field);
      return !isBlank(v) && Number.isNaN(Date.parse(v));
    }),
  },
  sum_equals: {
    needsArgs: ['addends'],
    describe: (i) => `${i.field} equals ${i.args.addends.join(' + ')}`,
    violations: (items, i) => items.filter(x => {
      const total = at(x, i.field);
      if (typeof total !== 'number') return false;
      const parts = i.args.addends.map(f => at(x, f));
      if (parts.some(p => typeof p !== 'number')) return false;
      return Math.abs(total - parts.reduce((a, b) => a + b, 0)) > 1e-6;
    }),
  },
  lte_field: {
    needsArgs: ['other'],
    describe: (i) => `${i.field} never exceeds ${i.args.other}`,
    violations: (items, i) => items.filter(x => {
      const a = at(x, i.field), b = at(x, i.args.other);
      return typeof a === 'number' && typeof b === 'number' && a > b;
    }),
  },
  ordered_desc: {
    describe: (i) => `the collection is ordered by ${i.field}, newest or largest first`,
    violations: (items, i) => {
      const values = items.map(x => at(x, i.field))
        .map(v => (typeof v === 'string' ? Date.parse(v) : v))
        .filter(v => typeof v === 'number' && !Number.isNaN(v));
      const out = [];
      for (let n = 1; n < values.length; n++) if (values[n] > values[n - 1]) out.push(items[n]);
      return out;
    },
  },
  null_when_zero: {
    needsArgs: ['when'],
    describe: (i) => `${i.field} is null wherever ${i.args.when} is zero`,
    violations: (items, i) => items.filter(x =>
      at(x, i.args.when) === 0 && !isBlank(at(x, i.field))),
  },
  present_when: {
    needsArgs: ['when', 'equals'],
    describe: (i) => `${i.field} is present wherever ${i.args.when} is ${JSON.stringify(i.args.equals)}`,
    violations: (items, i) => items.filter(x =>
      at(x, i.args.when) === i.args.equals && isBlank(at(x, i.field))),
  },
};

export const PREDICATE_NAMES = Object.keys(PREDICATES);

/** The schema the model must answer in. Keeps proposals inside the vocabulary. */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          field: { type: 'string' },
          predicate: { type: 'string', enum: PREDICATE_NAMES },
          args: { type: 'object' },
          reasoning: { type: 'string' },
        },
        required: ['claim', 'field', 'predicate'],
      },
    },
  },
  required: ['invariants'],
};

/** A stable identity, so the same claim proposed twice is recognised as one. */
export function keyOf(inv) {
  return `${inv.endpoint}|${inv.field}|${inv.predicate}|${JSON.stringify(inv.args ?? {})}`;
}

/**
 * Structural validation, run before anything touches the API: is the predicate
 * real, are its arguments there, and does the field actually exist in the data
 * we sampled? A field the model invented is the most common failure mode.
 */
export function validateProposal(inv, knownFields) {
  const spec = PREDICATES[inv.predicate];
  if (!spec) return `unknown predicate "${inv.predicate}"`;
  for (const arg of spec.needsArgs ?? []) {
    if (inv.args?.[arg] === undefined) return `predicate ${inv.predicate} needs args.${arg}`;
  }
  if (!knownFields.has(inv.field)) return `field "${inv.field}" does not exist on this endpoint`;
  for (const other of [inv.args?.other, inv.args?.when, ...(inv.args?.addends ?? [])]) {
    if (other !== undefined && !knownFields.has(other)) return `referenced field "${other}" does not exist`;
  }
  if (inv.predicate === 'enum_subset' && !Array.isArray(inv.args?.values)) {
    return 'enum_subset needs args.values as an array';
  }
  if (inv.predicate === 'matches') {
    try { new RegExp(inv.args.pattern); } catch { return `args.pattern is not a valid regex`; }
  }
  return null;
}

/**
 * Check one invariant against sampled items.
 * `applicable` counts the rows the predicate could actually speak about — an
 * invariant that held over zero relevant rows has proved nothing.
 */
export function evaluate(invariant, items) {
  const spec = PREDICATES[invariant.predicate];
  const violations = spec.violations(items, invariant);
  // How many rows the predicate could actually speak about. For a value test,
  // a null is not evidence — `session_id parses as a timestamp` over 100 nulls
  // has proved nothing, and must not be promoted on that basis.
  const applicable = ({
    null_when_zero: () => items.filter(x => at(x, invariant.args.when) === 0).length,
    present_when:   () => items.filter(x => at(x, invariant.args.when) === invariant.args.equals).length,
    always_present: () => items.length,          // presence is the claim
    never_null:     () => items.length,          // nullness is the claim
    unique:         () => items.filter(x => !isBlank(at(x, invariant.field))).length,
    ordered_desc:   () => items.filter(x => !isBlank(at(x, invariant.field))).length,
  }[invariant.predicate] ?? (() => items.filter(x => !isBlank(at(x, invariant.field))).length))();

  return {
    held: violations.length === 0,
    sampled: items.length,
    applicable,
    violations: violations.length,
    counterexamples: violations.slice(0, 2).map(x => ({
      id: x.id ?? x.name ?? null,
      value: at(x, invariant.field),
      ...(invariant.args?.when ? { [invariant.args.when]: at(x, invariant.args.when) } : {}),
    })),
  };
}

export function describe(invariant) {
  return PREDICATES[invariant.predicate]?.describe(invariant) ?? invariant.claim;
}
