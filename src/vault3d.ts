// Procedural vault door for the home page. No downloaded models: every part is built here.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type Key = { x: number; y: number; s: number; ry: number; rx: number; wheel: number; bolts: number; held: number };

const SAFE = new THREE.Color('#0a7a5a');
const HELD = new THREE.Color('#d08a1c');
const DIM = new THREE.Color('#38423d');

export function mountVault(canvas: HTMLCanvasElement, opts: { onReady: () => void }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 12);

  const key = new THREE.DirectionalLight('#ffffff', 1.6);
  key.position.set(4, 6, 8);
  scene.add(key, new THREE.AmbientLight('#ffffff', 0.25));

  // Materials
  const steel = new THREE.MeshStandardMaterial({ color: '#b9c0bb', metalness: 0.92, roughness: 0.32 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#4a534e', metalness: 0.85, roughness: 0.42 });
  const brushed = new THREE.MeshStandardMaterial({ color: '#d7dcd8', metalness: 1, roughness: 0.22 });
  const ink = new THREE.MeshStandardMaterial({ color: '#18201c', metalness: 0.4, roughness: 0.6 });

  const door = new THREE.Group();
  scene.add(door);

  // Frame: a thick ring the door sits in.
  const framePts = [
    [1.18, -0.28], [1.42, -0.28], [1.5, -0.2], [1.5, 0.12], [1.42, 0.2], [1.18, 0.2],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const frame = new THREE.Mesh(new THREE.LatheGeometry(framePts, 96), darkSteel);
  frame.rotation.x = Math.PI / 2;
  door.add(frame);

  // Door face: stepped profile, turned on a lathe.
  const facePts = [
    [0, 0.34], [0.42, 0.34], [0.46, 0.3], [0.62, 0.3], [0.66, 0.26], [0.98, 0.26], [1.04, 0.2], [1.12, 0.18], [1.14, 0.1], [1.14, -0.2], [0, -0.2],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const face = new THREE.Mesh(new THREE.LatheGeometry(facePts, 128), steel);
  face.rotation.x = Math.PI / 2;
  door.add(face);

  // Tick ring on the frame: lights up while a withdrawal waits.
  const TICKS = 60;
  const tickGeo = new THREE.BoxGeometry(0.035, 0.12, 0.04);
  const ticks: THREE.Mesh[] = [];
  for (let i = 0; i < TICKS; i++) {
    const m = new THREE.Mesh(tickGeo, new THREE.MeshStandardMaterial({ color: DIM, emissive: new THREE.Color(0), metalness: 0.3, roughness: 0.5 }));
    const a = (i / TICKS) * Math.PI * 2;
    m.position.set(Math.sin(a) * 1.33, Math.cos(a) * 1.33, 0.22);
    m.rotation.z = -a;
    door.add(m);
    ticks.push(m);
  }

  // Locking bolts around the rim.
  const bolts: THREE.Mesh[] = [];
  const boltGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.24, 24);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const b = new THREE.Mesh(boltGeo, brushed);
    b.rotation.z = -a;
    b.userData.a = a;
    door.add(b);
    bolts.push(b);
  }

  // Handle wheel: hub, rim and three spokes.
  const wheel = new THREE.Group();
  wheel.position.z = 0.42;
  door.add(wheel);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.045, 20, 96), brushed);
  wheel.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.16, 48), brushed);
  hub.rotation.x = Math.PI / 2;
  wheel.add(hub);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 16), brushed);
    spoke.rotation.z = (i / 3) * Math.PI;
    wheel.add(spoke);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 16), ink);
    const a = (i / 3) * Math.PI * 2;
    knob.position.set(Math.sin(a) * 0.5, Math.cos(a) * 0.5, 0);
    wheel.add(knob);
    const knob2 = knob.clone();
    knob2.position.set(-knob.position.x, -knob.position.y, 0);
    wheel.add(knob2);
  }

  // Status lamp at the top of the frame.
  const lampMat = new THREE.MeshStandardMaterial({ color: SAFE, emissive: SAFE, emissiveIntensity: 1.4, roughness: 0.3 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), lampMat);
  lamp.position.set(0, 1.62, 0.12);
  door.add(lamp);

  const glow = new THREE.PointLight(SAFE, 3, 6, 2);
  glow.position.set(0, 0, 2.2);
  door.add(glow);

  let w = 1, h = 1;
  function resize() {
    w = canvas.clientWidth; h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const tmpC = new THREE.Color();
  function apply(k: Key) {
    // Convert screen-relative placement to world units at z = 0.
    const vh = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    const vw = vh * camera.aspect;
    door.position.set(k.x * vw, k.y * vh, 0);
    const minDim = Math.min(vw, vh);
    door.scale.setScalar((k.s * minDim) / 3);
    door.rotation.set(k.rx, k.ry, 0);
    wheel.rotation.z = k.wheel;
    for (const b of bolts) {
      const r = 0.92 + 0.3 * k.bolts;
      b.position.set(Math.sin(b.userData.a) * r, Math.cos(b.userData.a) * r, 0.24);
    }
    const lit = Math.round(k.held * TICKS);
    for (let i = 0; i < TICKS; i++) {
      const m = ticks[i].material as THREE.MeshStandardMaterial;
      const on = i < lit;
      m.color.copy(on ? HELD : DIM);
      m.emissive.copy(on ? HELD : tmpC.setRGB(0, 0, 0));
      m.emissiveIntensity = on ? 0.9 : 0;
    }
    const c = tmpC.copy(SAFE).lerp(HELD, Math.min(1, k.held * 1.5));
    lampMat.color.copy(c); lampMat.emissive.copy(c);
    glow.color.copy(c);
  }

  function render() { renderer.render(scene, camera); }

  resize();
  let ready = false;
  return {
    resize,
    draw(k: Key) {
      apply(k);
      render();
      if (!ready) { ready = true; opts.onReady(); }
    },
    dispose() { renderer.dispose(); pmrem.dispose(); },
  };
}
