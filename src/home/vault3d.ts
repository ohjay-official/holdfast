import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type DoorState = { x: number; y: number; s: number; ry: number; rx: number; wheel: number; bolts: number; held: number };
export interface VaultHandle { draw(st: DoorState): void; resize(): void; dispose(): void }

const GREEN = new THREE.Color(0x3fa483), AMBER = new THREE.Color(0xcf9136);

export function mountVault(canvas: HTMLCanvasElement, opts: { onReady?: () => void } = {}): VaultHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  scene.add(new THREE.HemisphereLight(0x9fdcc4, 0x050706, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-4, 5, 6); scene.add(key);
  const rim = new THREE.PointLight(0x3fa483, 40, 20, 2); rim.position.set(3.5, 1.8, -1.5); scene.add(rim);
  const warm = new THREE.PointLight(0xcf9136, 0, 14, 2); warm.position.set(0, -2.5, 3.5); scene.add(warm);

  const steel  = new THREE.MeshPhysicalMaterial({ color: 0x9aa6a0, metalness: 1, roughness: 0.32, clearcoat: 0.4, clearcoatRoughness: 0.35 });
  const dark   = new THREE.MeshPhysicalMaterial({ color: 0x18201c, metalness: 0.85, roughness: 0.45 });
  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xdfe6e1, metalness: 1, roughness: 0.12 });
  const boltMat = new THREE.MeshPhysicalMaterial({ color: 0xc9d3ce, metalness: 1, roughness: 0.2, emissive: 0x000000 });
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x0a7a5a, emissive: GREEN.clone(), emissiveIntensity: 2.4 });

  const door = new THREE.Group(); scene.add(door);

  // frame ring + teeth
  door.add(new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.32, 32, 160), dark));
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.22, 0.18), steel, 72);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    p.set(Math.cos(a) * 2.05, Math.sin(a) * 2.05, 0.3); q.setFromAxisAngle(Z, a - Math.PI / 2);
    teeth.setMatrixAt(i, m.compose(p, q, one));
  }
  door.add(teeth);

  // slab, face, groove
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.42, 128), steel); slab.rotation.x = Math.PI / 2; slab.position.z = 0.1; door.add(slab);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.42, 0.1, 128), dark); face.rotation.x = Math.PI / 2; face.position.z = 0.34; door.add(face);
  const groove = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.025, 12, 160), chrome); groove.position.z = 0.32; door.add(groove);

  // radial bolts (slide out when locked)
  const bolts: THREE.Mesh[] = [];
  const boltGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.36, 24);
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(boltGeo, boltMat); const a = (i / 10) * Math.PI * 2 + Math.PI / 10;
    b.userData.a = a; b.rotation.z = a - Math.PI / 2; b.position.z = 0.4; door.add(b); bolts.push(b);
  }

  // handle wheel
  const wheel = new THREE.Group(); wheel.position.z = 0.52; door.add(wheel);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.055, 16, 96), chrome));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.22, 48), chrome); hub.rotation.x = Math.PI / 2; wheel.add(hub);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 16), chrome);
    sp.position.set(Math.cos(a) * 0.36, Math.sin(a) * 0.36, 0); sp.rotation.z = a - Math.PI / 2; wheel.add(sp);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.085, 24, 16), dark);
    knob.position.set(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.02); wheel.add(knob);
  }

  // status LED
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), ledMat); led.position.set(0, 1.1, 0.4); door.add(led);

  const DOOR_D = 4.74; // outer diameter in world units
  let w = 1, h = 1;
  function resize() {
    w = canvas.clientWidth || innerWidth; h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function draw(st: DoorState) {
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z, halfW = halfH * camera.aspect;
    door.position.set(st.x * 2 * halfW, -st.y * 2 * halfH, 0);
    door.scale.setScalar((st.s * 2 * halfH) / DOOR_D);
    door.rotation.set(st.rx, st.ry, 0);
    wheel.rotation.z = st.wheel;
    const r = 1.2 + 0.4 * st.bolts; // bolts slide outward across the slab ring
    for (const b of bolts) { const a = b.userData.a as number; b.position.x = Math.cos(a) * r; b.position.y = Math.sin(a) * r; }
    const c = GREEN.clone().lerp(AMBER, st.held);
    ledMat.emissive.copy(c); boltMat.emissive.copy(AMBER).multiplyScalar(st.held * 0.35);
    warm.intensity = 28 * st.held; rim.intensity = 40 * (1 - st.held * 0.6);
    renderer.render(scene, camera);
  }
  resize();
  requestAnimationFrame(() => opts.onReady?.());
  return { draw, resize, dispose() { renderer.dispose(); pmrem.dispose(); } };
}
