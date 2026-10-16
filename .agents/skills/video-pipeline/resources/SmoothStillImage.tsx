import React from 'react';
import { Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export type MotionPreset =
  | 'zoom_in_slow'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_right'
  | 'pan_left'
  | 'static';

export interface SmoothStillImageProps {
  /** Absolute or public-dir URI of the high-resolution image asset */
  src: string;
  /** Declarative motion preset from script_manifest.json */
  motion?: MotionPreset;
  /** Optional explicit duration in frames (defaults to composition/sequence duration) */
  durationInFrames?: number;
  /** Optional custom CSS filter or vignette contrast adjustments */
  filter?: string;
  /** Optional objectFit override */
  objectFit?: React.CSSProperties['objectFit'];
}

/**
 * SmoothStillImage — Sub-Pixel Quantization Jitter Prevention Component
 *
 * Why standard CSS/Remotion Ken Burns animations jitter:
 * When rendering slow 2%–8% pans or zooms over 150–400 frames at 30fps,
 * 2D integer pixel snapping or unhinted layer compositing causes visible
 * 1px stair-stepping ("화면 떨림 / Ken Burns Jitter").
 *
 * How SmoothStillImage eliminates jitter:
 * 1. Forces GPU 3D compositor pipeline via `will-change: transform` and `backfaceVisibility: 'hidden'`.
 * 2. Uses `translate3d(x, y, 0px) scale3d(s, s, 1)` rounded to 4 decimal places.
 * 3. Applies a constant `rotate(0.01deg)` micro-rotation to force bilinear/trilinear
 *    sub-pixel anti-aliasing in Chromium/Skia rasterizers on every frame.
 */
export const SmoothStillImage: React.FC<SmoothStillImageProps> = ({
  src,
  motion = 'zoom_in_slow',
  durationInFrames: explicitDuration,
  filter = 'contrast(1.02) saturate(1.02)',
  objectFit = 'cover',
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames: configDuration } = useVideoConfig();
  const totalFrames = Math.max(1, explicitDuration ?? configDuration);

  const progress = interpolate(frame, [0, totalFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  let scale = 1.0;
  let translateX = 0.0;
  let translateY = 0.0;

  switch (motion) {
    case 'zoom_in_slow':
      scale = interpolate(progress, [0, 1], [1.0, 1.045]);
      translateX = interpolate(progress, [0, 1], [0.0, -8.0]);
      translateY = interpolate(progress, [0, 1], [0.0, -4.5]);
      break;
    case 'zoom_in':
      scale = interpolate(progress, [0, 1], [1.0, 1.085]);
      translateX = interpolate(progress, [0, 1], [0.0, -14.0]);
      translateY = interpolate(progress, [0, 1], [0.0, -8.0]);
      break;
    case 'zoom_out':
      scale = interpolate(progress, [0, 1], [1.085, 1.0]);
      translateX = interpolate(progress, [0, 1], [-12.0, 0.0]);
      translateY = interpolate(progress, [0, 1], [-6.0, 0.0]);
      break;
    case 'pan_right':
      scale = 1.06;
      translateX = interpolate(progress, [0, 1], [-24.0, 24.0]);
      translateY = interpolate(progress, [0, 1], [-2.0, 2.0]);
      break;
    case 'pan_left':
      scale = 1.06;
      translateX = interpolate(progress, [0, 1], [24.0, -24.0]);
      translateY = interpolate(progress, [0, 1], [2.0, -2.0]);
      break;
    case 'static':
    default:
      scale = 1.005;
      translateX = 0.0;
      translateY = 0.0;
      break;
  }

  const tx = translateX.toFixed(4);
  const ty = translateY.toFixed(4);
  const sc = scale.toFixed(4);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        backgroundColor: '#050811',
      }}
    >
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          willChange: 'transform',
          backfaceVisibility: 'hidden',
          WebkitFontSmoothing: 'antialiased',
          filter,
          transformOrigin: '50% 50%',
          transform: `translate3d(${tx}px, ${ty}px, 0px) scale3d(${sc}, ${sc}, 1) rotate(0.01deg)`,
        }}
      />
    </div>
  );
};

export default SmoothStillImage;
