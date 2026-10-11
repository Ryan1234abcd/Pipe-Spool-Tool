// Builds revit/Spool connectors.dyn (a Dynamo 2.x graph) around
// revit/spool_connectors.py, so the graph always carries the current script.
//
//   node scripts/make-dyn.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(ROOT, 'revit', 'spool_connectors.py'), 'utf8');
const id = (seed) => crypto.createHash('md5').update(`spool-connectors:${seed}`).digest('hex'); // stable ids
const port = (seed, name, description) => ({ Id: id(seed), Name: name, Description: description, UsingDefaultValue: false, Level: 2, UseLevels: false, KeepListStructure: false });
const base = (seed, concrete, nodeType, description, inputs, outputs, extra = {}) => ({
  ConcreteType: concrete, NodeType: nodeType, Id: id(seed), Inputs: inputs, Outputs: outputs, Replication: 'Disabled', Description: description, ...extra,
});

const nodes = [
  base('file', 'CoreNodeModels.Input.Filename, CoreNodeModels', 'ExtensionNode', 'The <spool>-connectors.json file saved with the STEP export',
    [], [port('file.out', '', 'File Path')], { HintPath: '', InputValue: '' }),
  base('system', 'CoreNodeModels.Input.StringInput, CoreNodeModels', 'StringInputNode', 'Pipe system classification',
    [], [port('system.out', '', 'String')], { InputValue: 'OtherPipe' }),
  base('nominal', 'CoreNodeModels.Input.BoolSelector, CoreNodeModels', 'BooleanInputNode', 'True: connector diameter = nominal size (DN). False: pipe OD',
    [], [port('nominal.out', '', 'Boolean')], { InputValue: true }),
  base('visible', 'CoreNodeModels.Input.BoolSelector, CoreNodeModels', 'BooleanInputNode', 'True: leave the connector discs visible',
    [], [port('visible.out', '', 'Boolean')], { InputValue: false }),
  base('python', 'PythonNodeModels.PythonNode, PythonNodeModels', 'PythonScriptNode', 'Adds a pipe connector at every open end of the spool',
    [0, 1, 2, 3].map((i) => port(`python.in${i}`, `IN[${i}]`, `Input #${i}`)), [port('python.out', 'OUT', 'Result of the python script')],
    { Code: code, Engine: 'CPython3', VariableInputPorts: true }),
  base('watch', 'CoreNodeModels.Watch, CoreNodeModels', 'ExtensionNode', 'What was added',
    [port('watch.in', '', 'Node to show output from')], [port('watch.out', '', 'Node output')]),
];
const links = [['file.out', 'python.in0'], ['system.out', 'python.in1'], ['nominal.out', 'python.in2'], ['visible.out', 'python.in3'], ['python.out', 'watch.in']];
const views = [
  ['file', 'Connector file (.json)', 0, 0, true], ['system', 'Pipe system', 0, 120, true], ['nominal', 'Diameter = nominal size', 0, 220, true],
  ['visible', 'Discs visible', 0, 320, true], ['python', 'Add pipe connectors', 420, 120, false], ['watch', 'Result', 760, 120, false],
];
const graph = {
  Uuid: id('graph'), IsCustomNode: false, Description: 'Pipe Spool Tool: adds Revit pipe connectors at the open ends of an imported spool (family editor).',
  Name: 'Spool connectors', ElementResolver: { ResolutionMap: {} }, Inputs: [], Outputs: [],
  Nodes: nodes,
  Connectors: links.map(([a, b]) => ({ Start: id(a), End: id(b), Id: id(`${a}>${b}`), IsHidden: 'False' })),
  Dependencies: [], NodeLibraryDependencies: [], Bindings: [],
  View: {
    Dynamo: { ScaleFactor: 1.0, HasRunWithoutCrash: false, IsVisibleInDynamoLibrary: true, Version: '2.13.1.3887', RunType: 'Manual', RunPeriod: '1000' },
    Camera: { Name: 'Background Preview', EyeX: -17, EyeY: 24, EyeZ: 50, LookX: 12, LookY: -13, LookZ: -58, UpX: 0, UpY: 1, UpZ: 0 },
    NodeViews: views.map(([seed, name, x, y, input]) => ({ Id: id(seed), Name: name, IsSetAsInput: input, IsSetAsOutput: false, Excluded: false, ShowGeometry: true, X: x, Y: y })),
    Annotations: [], X: 0, Y: 0, Zoom: 1,
  },
};
fs.writeFileSync(path.join(ROOT, 'revit', 'Spool connectors.dyn'), `${JSON.stringify(graph, null, 2)}\n`);
console.log('wrote revit/Spool connectors.dyn');
