// Three.js viewport with an isometric orthographic camera (Z up, like Revit).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/CSS2DRenderer.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f6f9);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, -0.6, 1.4);
    this.camera.add(sun);
    this.scene.add(this.camera);

    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.axes = this._makeAxes();
    this.scene.add(this.axes);

    this.zoomExtent = 1000;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setView('iso');
  }

  _makeAxes() {
    const g = new THREE.Group();
    const cols = [0xd9534f, 0x5cb85c, 0x337ab7];
    const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    dirs.forEach((d, i) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...d).multiplyScalar(100)]);
      g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: cols[i] })));
    });
    return g;
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    const aspect = w / h;
    const e = this.zoomExtent;
    this.camera.left = -e * aspect; this.camera.right = e * aspect;
    this.camera.top = e; this.camera.bottom = -e;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** 'iso' | 'top' | 'front' | 'right' | 'iso2' */
  setView(kind) {
    const views = {
      iso: [1, -1, 1], iso2: [-1, -1, 1], iso3: [-1, 1, 1], iso4: [1, 1, 1],
      top: [0, -0.0001, 1], front: [0, -1, 0], right: [1, 0, 0], back: [0, 1, 0], left: [-1, 0, 0],
    };
    const v = new THREE.Vector3(...(views[kind] || views.iso)).normalize();
    const t = this.controls.target;
    this.camera.position.copy(t).add(v.multiplyScalar(5000));
    this.camera.lookAt(t);
    this.controls.update();
    this.render();
  }

  fit(object = this.content, margin = 1.15) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() / 2;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).add(dir.multiplyScalar(Math.max(size * 10, 5000)));
    this.camera.lookAt(centre);
    this.camera.updateMatrixWorld();
    // extent of the box as seen by the camera, so the fit is tight in any view
    const inv = this.camera.matrixWorldInverse;
    let hw = 0, hh = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).applyMatrix4(inv).sub(centre.clone().applyMatrix4(inv));
      hw = Math.max(hw, Math.abs(p.x)); hh = Math.max(hh, Math.abs(p.y));
    }
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
    this.zoomExtent = Math.max(Math.max(hh, hw / aspect) * margin, 50);
    this.camera.zoom = 1;
    this.axes.scale.setScalar(Math.max(size / 400, 0.3));
    this.resize();
    this.controls.update();
  }

  clear() {
    for (const c of [...this.content.children]) {
      this.content.remove(c);
      c.traverse((o) => {
        if (o.isCSS2DObject) o.element.remove();
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      });
    }
  }

  pick(event, objects) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.intersectObjects(objects, true);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

/** BufferGeometry from the server mesh format {positions, indices}. */
export function geometryFromMesh(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  g.setIndex(mesh.indices);
  g.computeVertexNormals();
  g.userData.shared = true;
  return g;
}

export function toMatrix4(m) {
  const M = new THREE.Matrix4();
  M.set(...m[0], ...m[1], ...m[2], ...m[3]);
  return M;
}
