// CAD kernel wrapper around OpenCascade (replicad-opencascadejs WebAssembly build).
// Runs inside a Web Worker in the browser (see cad-worker.js) and directly in
// node for the tests. All lengths are millimetres.

export class Cad {
  constructor(oc) {
    this.oc = oc;
    this.n = 0;
  }

  _tmp(ext) { return `/tmp_${++this.n}.${ext}`; }
  _range() { return new this.oc.Message_ProgressRange(); }

  /** Read STEP bytes (Uint8Array) into one shape (compound if several roots). */
  readStep(bytes) {
    const { oc } = this;
    const path = this._tmp('stp');
    oc.FS.writeFile(path, bytes);
    try {
      const reader = new oc.STEPControl_Reader();
      const status = reader.ReadFile(path);
      if (String(status) !== 'IFSelect_RetDone') throw new Error('Could not read the STEP file');
      reader.TransferRoots(this._range());
      const shape = reader.OneShape();
      reader.delete();
      if (shape.IsNull()) throw new Error('The STEP file has no geometry');
      return shape;
    } finally {
      oc.FS.unlink(path);
    }
  }

  /** Write a shape to STEP (AP214, mm). Returns Uint8Array. */
  writeStep(shape, name = 'Spool') {
    const { oc } = this;
    oc.Interface_Static.SetCVal('write.step.schema', 'AP214IS');
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    oc.Interface_Static.SetCVal('write.step.product.name', name);
    // no 2D copies of every edge on its faces (they more than double the file)
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 0);
    const writer = new oc.STEPControl_Writer();
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, this._range());
    const path = this._tmp('stp');
    const status = writer.Write(path);
    writer.delete();
    if (String(status) !== 'IFSelect_RetDone') throw new Error('STEP export failed');
    const data = oc.FS.readFile(path);
    oc.FS.unlink(path);
    return compactStep(data);
  }

  /** Triangulate for display: {positions, indices, bbox}. */
  mesh(shape, deflection) {
    const { oc } = this;
    if (!deflection) {
      const bb = this.bbox(shape);
      const diag = Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]) || 100;
      deflection = Math.max(0.05, Math.min(2, diag / 600));
    }
    new oc.BRepMesh_IncrementalMesh(shape, deflection, false, 0.3, false).delete();
    const positions = [];
    const indices = [];
    const exp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face(exp.Current());
      const loc = new oc.TopLoc_Location();
      const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
      if (!tri || (tri.IsNull && tri.IsNull())) { loc.delete(); continue; }
      const trsf = loc.Transformation();
      const base = positions.length / 3;
      const nn = tri.NbNodes();
      for (let i = 1; i <= nn; i++) {
        const p = tri.Node(i).Transformed(trsf);
        positions.push(p.X(), p.Y(), p.Z());
        p.delete();
      }
      const reversed = String(face.Orientation()) === 'TopAbs_REVERSED';
      const nt = tri.NbTriangles();
      for (let i = 1; i <= nt; i++) {
        const t = tri.Triangle(i);
        const a = t.Value(1), b = t.Value(2), c = t.Value(3);
        if (reversed) indices.push(base + a - 1, base + c - 1, base + b - 1);
        else indices.push(base + a - 1, base + b - 1, base + c - 1);
      }
      loc.delete();
    }
    exp.delete();
    const bbox = boundsOf(positions);
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices), bbox };
  }

  bbox(shape) {
    const { oc } = this;
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, box, false);
    const min = box.CornerMin(), max = box.CornerMax();
    const r = [[min.X(), min.Y(), min.Z()], [max.X(), max.Y(), max.Z()]];
    box.delete();
    return r;
  }

  /** All circular edges: [{centre, axis, radius, span}] (for port detection). */
  circles(shape) {
    const { oc } = this;
    const out = [];
    const exp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) {
      const edge = oc.TopoDS.Edge(exp.Current());
      const ad = new oc.BRepAdaptor_Curve(edge);
      if (String(ad.GetType()) === 'GeomAbs_Circle') {
        const c = ad.Circle();
        const loc = c.Location();
        const d = c.Axis().Direction();
        out.push({
          centre: [loc.X(), loc.Y(), loc.Z()],
          axis: [d.X(), d.Y(), d.Z()],
          radius: c.Radius(),
          span: Math.abs(ad.LastParameter() - ad.FirstParameter()),
        });
      }
      ad.delete();
    }
    exp.delete();
    return out;
  }

  /** Straight pipe along +X from the origin. id = 0 gives a solid bar. */
  makePipe(od, id, length) {
    const { oc } = this;
    if (!(length > 0)) throw new Error('Pipe length must be greater than zero');
    const axis = (x0) => new oc.gp_Ax2(new oc.gp_Pnt(x0, 0, 0), new oc.gp_Dir(1, 0, 0));
    const outer = new oc.BRepPrimAPI_MakeCylinder(axis(0), od / 2, length).Shape();
    if (!(id > 0)) return outer;
    const inner = new oc.BRepPrimAPI_MakeCylinder(axis(-1), id / 2, length + 2).Shape();
    const cut = new oc.BRepAlgoAPI_Cut(outer, inner, this._range());
    const r = cut.Shape();
    cut.delete();
    return r;
  }

  _pnt(p) { return new this.oc.gp_Pnt(p[0], p[1], p[2]); }
  _dir(d) { return new this.oc.gp_Dir(d[0], d[1], d[2]); }

  /** Solid of revolution: profile [[h, r]…] about the line o + h·d, closed to the axis. */
  revolve(o, d, x, pts) {
    const { oc } = this;
    const at = (h, r) => [0, 1, 2].map((i) => o[i] + d[i] * h + x[i] * r);
    const ring = [[pts[0][0], 0], ...pts, [pts[pts.length - 1][0], 0]];
    const poly = [];
    for (const q of ring) {
      const last = poly[poly.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-4) poly.push(q);
    }
    // drop points on a straight line between their neighbours (one face per straight run)
    for (let i = 1; i < poly.length - 1;) {
      const [a, b, c] = [poly[i - 1], poly[i], poly[i + 1]];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cr) / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1) < 0.01) poly.splice(i, 1); else i++; // within 0.01 mm
    }
    if (poly.length < 3) throw new Error('Degenerate profile');
    const wire = new oc.BRepBuilderAPI_MakeWire();
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-4) continue;
      const e = new oc.BRepBuilderAPI_MakeEdge(this._pnt(at(...a)), this._pnt(at(...b)));
      wire.Add(e.Edge());
      e.delete();
    }
    const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true);
    const rev = new oc.BRepPrimAPI_MakeRevol(face.Face(), new oc.gp_Ax1(this._pnt(o), this._dir(d)), 2 * Math.PI, false);
    const shape = rev.Shape();
    wire.delete(); face.delete(); rev.delete();
    return shape;
  }

  /** Box given in the frame (o; x, y, z) from min to max. */
  box(o, x, y, z, min, max) {
    const corner = [0, 1, 2].map((i) => o[i] + x[i] * min[0] + y[i] * min[1] + z[i] * min[2]);
    const size = [0, 1, 2].map((k) => Math.max(max[k] - min[k], 0.01));
    const ax = new this.oc.gp_Ax2(this._pnt(corner), this._dir(z), this._dir(x));
    return new this.oc.BRepPrimAPI_MakeBox(ax, size[0], size[1], size[2]).Shape();
  }

  /** Solid cylinder from o along d. */
  cylinder(o, d, r, L) {
    return new this.oc.BRepPrimAPI_MakeCylinder(new this.oc.gp_Ax2(this._pnt(o), this._dir(d)), r, L).Shape();
  }

  /** Ring segment (bend): centre c, axis n, starting towards x, sweeping angle (rad). */
  torus(c, n, x, R, r, angle) {
    const ax = new this.oc.gp_Ax2(this._pnt(c), this._dir(n), this._dir(x));
    return new this.oc.BRepPrimAPI_MakeTorus(ax, R, r, angle).Shape();
  }

  /** The solids in a shape (the shape itself if it has none). */
  solids(shape) {
    const { oc } = this;
    const out = [];
    const exp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) out.push(oc.TopoDS.Solid(exp.Current()));
    exp.delete();
    return out.length ? out : [shape];
  }

  /**
   * Fillers for round holes narrower than maxR: cylinders that plug them
   * (bolt holes, tapped holes, drain holes). Only whole holes, not the
   * concave fillets in inside corners. Returns wrap.js 'cyl' primitives.
   */
  holeFillers(shape, maxR) {
    const { oc } = this;
    const out = [];
    const exp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face(exp.Current());
      if (String(face.Orientation()) !== 'TopAbs_REVERSED') continue; // material outside the cylinder = a hole
      const ad = new oc.BRepAdaptor_Surface(face, true);
      try {
        if (String(ad.GetType()) !== 'GeomAbs_Cylinder') continue;
        const cyl = ad.Cylinder();
        const r = cyl.Radius();
        if (r > maxR || ad.LastUParameter() - ad.FirstUParameter() < 1.8 * Math.PI) continue;
        const ax = cyl.Axis();
        const o = [ax.Location().X(), ax.Location().Y(), ax.Location().Z()];
        const d = [ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()];
        // axial extent from the face's triangulation
        const loc = new oc.TopLoc_Location();
        const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
        if (!tri || (tri.IsNull && tri.IsNull())) { loc.delete(); continue; }
        const trsf = loc.Transformation();
        let h0 = Infinity, h1 = -Infinity;
        for (let i = 1; i <= tri.NbNodes(); i++) {
          const q = tri.Node(i).Transformed(trsf);
          const h = (q.X() - o[0]) * d[0] + (q.Y() - o[1]) * d[1] + (q.Z() - o[2]) * d[2];
          q.delete();
          if (h < h0) h0 = h;
          if (h > h1) h1 = h;
        }
        loc.delete();
        if (h1 - h0 < 1e-3) continue;
        out.push({ t: 'cyl', o: o.map((v, k) => v + d[k] * h0), d, r: r * 1.002, L: h1 - h0 });
      } finally { ad.delete(); }
    }
    exp.delete();
    return out;
  }

  /** Keep only the outer skin of each solid (internal voids are dropped). */
  outerSkin(shape) {
    const { oc } = this;
    const solids = this.solids(shape);
    const out = [];
    for (const so of solids) {
      const shells = [];
      const exp = new oc.TopExp_Explorer(so, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; exp.More(); exp.Next()) shells.push(oc.TopoDS.Shell(exp.Current()));
      exp.delete();
      if (shells.length < 2) { out.push(so); continue; }
      const size = (sh) => { const b = this.bbox(sh); return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]); };
      shells.sort((a, b) => size(b) - size(a));
      const mk = new oc.BRepBuilderAPI_MakeSolid(shells[0]);
      out.push(mk.Solid());
      mk.delete();
    }
    return out.length === 1 ? out[0] : this.compound(out);
  }

  /**
   * Shrink-wrap one part: its real outer surfaces, with hidden inner pieces
   * dropped, bores and threads filled, holes narrower than `res` plugged and
   * loose bits smaller than `res` left out, merged into one solid.
   * @param prims  filler primitives from wrap.js boreFillers()
   * @param keep   which of this.solids(shape) to keep (wrap.js visibleSolids)
   */
  shrinkWrap(shape, keep, prims, res) {
    const diag = (x) => { const b = this.bbox(x); return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]); };
    // hidden pieces, empty ones (springs drawn as surfaces) and bits smaller than res go
    const solids = this.solids(shape).filter((so, i) => keep[i] && this.volume(so) > 1e-3 && diag(so) >= res)
      .sort((a, b) => this.volume(b) - this.volume(a));
    if (!solids.length) return null;
    const holes = solids.flatMap((so) => this.holeFillers(so, res / 2));
    const fill = [...prims, ...holes].map((p) => this.buildPrimitives([p]));
    let f = this.fuse([...solids, ...fill]);
    let result;
    if (f.ok) result = f.shape;
    else {
      // merge one piece at a time, leaving out any piece that breaks the merge
      let acc = solids[0];
      const apart = [];
      for (const piece of [...solids.slice(1), ...fill]) {
        f = this.fuse([acc, piece]);
        if (f.ok) acc = f.shape;
        else if (solids.includes(piece)) apart.push(piece);
      }
      result = apart.length ? this.compound([acc, ...apart]) : acc;
    }
    const skin = this.outerSkin(result);
    try {
      const up = new this.oc.ShapeUpgrade_UnifySameDomain(skin, true, true, false);
      up.Build();
      const r = up.Shape();
      up.delete();
      return this.isValid(r) ? r : skin;
    } catch { return skin; }
  }

  /** One solid from a wrap.js primitive list. */
  buildPrimitives(list) {
    const shapes = list.map((p) => {
      switch (p.t) {
        case 'revolve': return this.revolve(p.o, p.d, p.x, p.pts);
        case 'box': return this.box(p.o, p.x, p.y, p.z, p.min, p.max);
        case 'cyl': return this.cylinder(p.o, p.d, p.r, p.L);
        case 'torus': return this.torus(p.c, p.n, p.x, p.R, p.r, p.angle);
        default: throw new Error(`Unknown primitive ${p.t}`);
      }
    });
    if (!shapes.length) throw new Error('Nothing to build');
    const f = this.fuse(shapes);
    return f.ok ? f.shape : this.compound(shapes);
  }

  /** Place a shape with a row-major 4x4 rigid transform. */
  place(shape, m) {
    const { oc } = this;
    const t = new oc.gp_Trsf();
    t.SetValues(m[0][0], m[0][1], m[0][2], m[0][3], m[1][0], m[1][1], m[1][2], m[1][3], m[2][0], m[2][1], m[2][2], m[2][3]);
    const loc = new oc.TopLoc_Location(t);
    return shape.Moved(loc, false);
  }

  compound(shapes) {
    const { oc } = this;
    const comp = new oc.TopoDS_Compound();
    const b = new oc.TopoDS_Builder();
    b.MakeCompound(comp);
    for (const s of shapes) b.Add(comp, s);
    b.delete();
    return comp;
  }

  /** Boolean union of all shapes. Returns {shape, ok}. */
  fuse(shapes) {
    const { oc } = this;
    if (shapes.length === 1) return { shape: shapes[0], ok: true };
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    args.Append(shapes[0]);
    for (const s of shapes.slice(1)) tools.Append(s);
    const op = new oc.BRepAlgoAPI_Fuse();
    op.SetArguments(args);
    op.SetTools(tools);
    op.SetFuzzyValue(1e-5);
    op.Build(this._range());
    if (!op.IsDone()) { op.delete(); return { shape: null, ok: false }; }
    let shape = op.Shape();
    try {
      const up = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
      up.Build();
      shape = up.Shape();
      up.delete();
    } catch { /* cosmetic only */ }
    op.delete();
    return { shape, ok: this.isValid(shape) };
  }

  isValid(shape) {
    const a = new this.oc.BRepCheck_Analyzer(shape, true, false);
    const ok = a.IsValid();
    a.delete();
    return ok;
  }

  count(shape, kind = 'TopAbs_SOLID') {
    const { oc } = this;
    const exp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let n = 0;
    for (; exp.More(); exp.Next()) n++;
    exp.delete();
    return n;
  }

  volume(shape) {
    const { oc } = this;
    const p = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, p, false, false, false);
    const v = p.Mass();
    p.delete();
    return v;
  }
}

/**
 * Shorter STEP text: numbers to 7 significant figures (0.001 mm on a 1 m part)
 * and one line per entity. Typically 10–15% smaller.
 */
export function compactStep(bytes) {
  const text = new TextDecoder().decode(bytes);
  const i = text.indexOf('DATA;');
  if (i < 0) return bytes;
  const body = text.slice(i)
    .replace(/(['])(?:[^']|'')*\1|-?\d+\.\d*(?:E[-+]?\d+)?/g, (m) => {
      if (m[0] === "'") return m; // leave strings alone
      const v = Number(m);
      if (!Number.isFinite(v)) return m;
      if (Math.abs(v) < 1e-12) return '0.';
      const str = String(Number(v.toPrecision(7)));
      return /[.eE]/.test(str) ? str.replace('e', 'E') : `${str}.`;
    })
    .replace(/\r?\n[ \t]+/g, ' ');
  return new TextEncoder().encode(text.slice(0, i) + body);
}

export function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return positions.length ? [min, max] : [[0, 0, 0], [0, 0, 0]];
}
