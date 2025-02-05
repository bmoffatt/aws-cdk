/**
 * From the SDKv3 repository, build an index of all types that are are "Blob"s or numbers,
 * so we can properly convert input strings to the right type.
 *
 * This is necessary for backwards compatibiltiy with SDKv2 which used to accept string
 * arguments liberally, but SDKv3 no longer does so we need to do the conversion ourselves.
 *
 * We are building a state machine for every shape. The state machine looks like this:
 *
 * ```
 * [
 *   { next: 1, other: 2 },
 *   { field: 'b' },
 *   { field2: 'n' },
 * ]
 * ```
 *
 * Where the ID of a state is the index in the array, and transitions are either:
 *
 *   'n' -> this field is a number type
 *   'b' -> this field is a blob type
 *   <number> -> move to another state
 *
 * We save a gzipped representation of this state machine to save bytes (the full decoded
 * model is ~300kB and we don't want to ship that for every custom resource).
 */
import * as path from 'path';
import * as zlib from 'zlib';
import { promises as fs } from 'fs';

/**
 * For every Smithy .json file in a directory, extract relevant types into a mapping and render them to a TypeScript file
 */
async function main(argv: string[]) {
  if (!argv[0]) {
    throw new Error('Usage: update-sdkv3-parameters-model <DIRECTORY>');
  }
  const dir = argv[0];

  const builder: StateMachineBuilder = {
    idToNumber: new Map(),
    stateMachine: [{}],
  };

  for (const entry of await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const contents = JSON.parse(await fs.readFile(path.join(dir, entry.name), { encoding: 'utf-8' }));
      if (contents.smithy !== '2.0') {
        console.error(`Skipping ${entry.name}`);
        continue;
      }
      try {
        await doFile(builder, contents);
      } catch (e) {
        throw new Error(`Error handling ${entry.name}: ${e}`);
      }
    }
  }

  if (Object.entries(builder.stateMachine[0]).length === 0) {
    throw new Error('No mappings found!');
  }

  // Sort the map so we're independent of the order the OS gave us the files in, or what the filenames are
  const sortedStateMachine = builder.stateMachine.map(sortedObject);
  if (process.env.DEBUG) {
    console.error(JSON.stringify(sortedStateMachine, undefined, 2));
  }
  renderStateMachineToTypeScript(sortedStateMachine);
}

/**
 * Recurse through all the types of a singly Smithy model, and record the blobs
 */
async function doFile(builder: StateMachineBuilder, model: SmithyFile) {
  const shapes = model.shapes;

  const service = Object.values(shapes).find(isShape('service'));
  if (!service) {
    throw new Error('Did not find service');
  }
  const _shortName = (service.traits?.['aws.api#service']?.arnNamespace
    ?? service.traits?.['aws.api#service']?.endpointPrefix
    ?? service.traits?.['aws.auth#sigv4']?.name);
  if (!_shortName) {
    throw new Error('Service does not have shortname');
  }
  const shortName = _shortName;

  // Sort operations so we have a stable order to minimize future diffs
  const operations = service.operations ?? [];
  operations.sort((a, b) => a.target.localeCompare(b.target));

  for (const operationTarget of operations) {
    const operation = shapes[operationTarget.target];
    if (!isShape('operation')(operation)) {
      throw new Error(`Not an operation: ${operationTarget.target}`);
    }
    if (operation.input) {
      const [, opName] = operationTarget.target.split('#');
      recurse([
        { fieldName: shortName, id: `service#${shortName}` }, // Only needs to be unique
        { fieldName: opName.toLowerCase(), id: operation.input.target }, // Operation
      ]);
    }
  }

  /**
   * Recurse through type shapes, finding the coercible types
   */
  function recurse(memberPath: PathElement[]) {
    const id = memberPath[memberPath.length - 1].id;

    // Short-circuit built-in types
    if (id.startsWith('smithy.api#')) {
      return;
    }
    // Short-circuit on self-recursion
    // We do want to see one path to self-recursion, so that we record the path
    // in the state machine, so we only abort on the 2nd self-recursion.
    const recursionLevel = memberPath.filter((e) => e.id === id).length - 1; // We will always be in there at least once
    if (recursionLevel > 1) {
      return;
    }
    const shape = shapes[id];

    if (isShape('blob')(shape)) {
      addCoercion(memberPath, 'b');
      return;
    }

    if (isNumber(shape)) {
      addCoercion(memberPath, 'n');
      return;
    }

    if (isShape('structure')(shape) || isShape('union')(shape)) {
      // const allKeys = Object.keys(shape.members ?? {}).sort();
      for (const [field, member] of Object.entries(shape.members ?? {}).sort(sortByKey)) {
        recurse([...memberPath, { fieldName: field, id: member.target }]);
      }
      return;
    }
    if (isShape('list')(shape)) {
      recurse([...memberPath, { fieldName: '*' , id: shape.member.target }]);
      return;
    }
    if (isShape('map')(shape)) {
      // Keys can't be Uint8Arrays anyway in JS, so check only values
      recurse([...memberPath, { fieldName: '*', id: shape.value.target }]);
      return;
    }
  }

  function addCoercion(memberPath: PathElement[], type: Exclude<TypeCoercionTarget, number>) {
    if (memberPath.length === 0) {
      throw new Error('Assertion error');
    }
    memberPath = [...memberPath];
    let stateIx = 0;
    while (memberPath.length > 1) {
      const transition = memberPath.shift()!;
      const nextStateIx = ensureState(transition.id);
      builder.stateMachine[stateIx][transition.fieldName] = nextStateIx;
      stateIx = nextStateIx;
    }
    builder.stateMachine[stateIx][memberPath.pop()!.fieldName] = type;
  }

  function ensureState(id: string): number {
    const existing = builder.idToNumber.get(id);
    if (existing) {
      return existing;
    }
    const i = builder.stateMachine.length;
    builder.stateMachine.push({});
    builder.idToNumber.set(id, i);
    return i;
  }
}

function renderStateMachineToTypeScript(sm: TypeCoercionStateMachine) {
  const stringified = JSON.stringify(sm);
  const compressed = zlib.brotliCompressSync(Buffer.from(stringified));

  const lines = new Array<string>();

  lines.push(
    `// This file was generated from the aws-sdk-js-v3 at ${new Date()}`,
    '/* eslint-disable quote-props,comma-dangle,quotes */',
    'import * as zlib from \'zlib\';',
    'export type TypeCoercionStateMachine = Array<Record<string, number | \'b\' | \'n\'>>',
    'export let typeCoercionStateMachine = (): TypeCoercionStateMachine => {',
    `  const encoded = ${JSON.stringify(compressed.toString('base64'))};`,
    '  const decoded = JSON.parse(zlib.brotliDecompressSync(Buffer.from(encoded, \'base64\')).toString());',
    '  typeCoercionStateMachine = () => decoded;',
    '  return decoded;',
    '};',
  );

  console.log(lines.join('\n'));
}

interface PathElement {
  fieldName: string;
  id: string;
}

type TypeCoercionStateMachine = TypeCoercionState[];

type TypeCoercionTarget = number | 'b' | 'n';
type TypeCoercionState = Record<string, TypeCoercionTarget>;

interface StateMachineBuilder {
  idToNumber: Map<string, number>;
  stateMachine: TypeCoercionStateMachine;
};

interface SmithyFile {
  shapes: Record<string, SmithyShape>;
}

type SmithyShape =
  | { type: 'service', operations?: SmithyTarget[], traits?: SmithyTraits }
  | { type: 'operation', input?: SmithyTarget, output: SmithyTarget, traits?: SmithyTraits }
  | { type: 'structure', members?: Record<string, SmithyTarget>, traits?: SmithyTraits }
  | { type: 'list', member: SmithyTarget }
  | { type: 'map', key: SmithyTarget, value: SmithyTarget }
  | { type: 'union', members?: Record<string, SmithyTarget> }
  | { type: string }
  ;

interface SmithyTarget {
  target: string
}

interface SmithyTraits {
  'aws.api#service'?: {
    sdkId?: string;
    arnNamespace?: string;
    cloudFormationName?: string;
    endpointPrefix?: string;
  };
  'aws.auth#sigv4'?: {
    name: string;
  };
}

function isShape<A extends string>(key: A) {
  return (x: SmithyShape): x is Extract<SmithyShape, { type: A }> => x.type === key;
}

function isNumber(shape: SmithyShape): boolean {
  return isShape('integer')(shape) ||
    isShape('float')(shape) ||
    isShape('double')(shape) ||
    isShape('long')(shape) ||
    isShape('short')(shape) ||
    isShape('bigInteger')(shape) ||
    isShape('bigDecimal')(shape) ||
    isShape('byte')(shape);
}

function sortByKey<A>(e1: [string, A], e2: [string, A]) {
  return e1[0].localeCompare(e2[0]);
}

function sortedObject<A extends object>(x: A): A {
  return Object.fromEntries(Object.entries(x).sort(sortByKey)) as any;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
