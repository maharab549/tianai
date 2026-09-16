import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

type AvatarStatus = 'loading' | 'ready' | 'error';

const MODEL_URL = '/avatars/avatar-sample-a.vrm';
const MOUTH_EXPRESSIONS = ['aa', 'ih', 'ou', 'ee', 'oh'];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export default function LiveAvatar() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<AvatarStatus>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'airi-live-avatar-canvas';
    renderer.domElement.setAttribute('aria-label', 'Live 3D family avatar');
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xd8f5f2, 0x18212b, 1.8));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(1.5, 3.2, 2.5);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x75c8d1, 1.1);
    rimLight.position.set(-2.5, 1.8, -2);
    scene.add(rimLight);

    let vrm: VRM | undefined;
    let disposed = false;
    let frame = 0;
    let lastTime = performance.now();
    let elapsed = 0;
    let blinkUntil = 0;
    let nextBlink = 2.5;
    let head: THREE.Object3D | undefined;
    let basePositionY = 0;
    let baseRotationY = 0;

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    loader.load(MODEL_URL, gltf => {
      if (disposed) return;
      vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        setStatus('error');
        return;
      }
      VRMUtils.rotateVRM0(vrm);
      baseRotationY = vrm.scene.rotation.y;
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const height = Math.max(size.y, 1);
      vrm.scene.position.x -= center.x;
      basePositionY = -bounds.min.y;
      vrm.scene.position.y = basePositionY;
      scene.add(vrm.scene);
      camera.position.set(0, height * 0.58, height * 2.8);
      camera.lookAt(0, height * 0.53, 0);
      head = vrm.humanoid?.getNormalizedBoneNode('head') || undefined;
      const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm');
      const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm');
      const leftLowerArm = vrm.humanoid?.getNormalizedBoneNode('leftLowerArm');
      const rightLowerArm = vrm.humanoid?.getNormalizedBoneNode('rightLowerArm');
      if (leftUpperArm) leftUpperArm.rotation.z = 1.05;
      if (rightUpperArm) rightUpperArm.rotation.z = -1.05;
      if (leftLowerArm) leftLowerArm.rotation.z = 0.12;
      if (rightLowerArm) rightLowerArm.rotation.z = -0.12;
      setStatus('ready');
    }, undefined, () => {
      if (!disposed) setStatus('error');
    });

    const animate = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      elapsed += delta;
      if (vrm) {
        const phase = document.documentElement.dataset.tianaiVoicePhase || 'off';
        const rawEnergy = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--airi-voice-energy'));
        const energy = Number.isFinite(rawEnergy) ? clamp(rawEnergy) : 0;
        const talking = phase === 'speaking';
        const expressionManager = vrm.expressionManager;
        if (expressionManager) {
          const mouthEnergy = talking ? clamp(0.08 + energy * 1.05) : 0;
          const syllable = Math.floor(elapsed * 8.5) % MOUTH_EXPRESSIONS.length;
          MOUTH_EXPRESSIONS.forEach((name, index) => {
            if (expressionManager.expressionMap[name]) {
              const distance = Math.abs(index - syllable);
              const weight = distance === 0 ? 1 : distance === 1 ? 0.24 : 0;
              expressionManager.setValue(name, mouthEnergy * weight);
            }
          });
          const blink = elapsed >= blinkUntil && elapsed < blinkUntil + 0.13 ? 1 : 0;
          if (elapsed >= nextBlink) {
            blinkUntil = elapsed;
            nextBlink = elapsed + 3.2 + Math.random() * 2.4;
          }
          if (expressionManager.expressionMap.blink) expressionManager.setValue('blink', blink);
          expressionManager.update();
        }
        if (head) {
          const sway = phase === 'listening' ? 0.025 : 0.012;
          head.rotation.y = Math.sin(elapsed * 0.72) * sway;
          head.rotation.x = Math.sin(elapsed * 0.52) * 0.012 + (talking ? energy * 0.012 : 0);
        }
        vrm.scene.position.y = basePositionY + Math.sin(elapsed * 0.9) * 0.008;
        vrm.scene.rotation.y = baseRotationY + Math.sin(elapsed * 0.34) * 0.025;
        vrm.update(delta);
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className={`airi-live-avatar ${status}`} aria-busy={status === 'loading'}>{status === 'loading' && <span className="airi-avatar-loading">loading avatar</span>}{status === 'error' && <span className="airi-avatar-error">avatar could not load</span>}</div>;
}
