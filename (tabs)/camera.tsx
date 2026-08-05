import React, { useRef, useState, useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, Text, ActivityIndicator, BackHandler, GestureResponderEvent } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState } from 'react-native';
const MAX_DURATION = 180; // 3 minutes

// =========================
// PREVIEW SCREEN
// Crash fix: this component (and therefore useVideoPlayer) is only
// ever mounted by the parent when a real, non-null video URI exists
// (see MAIN RETURN in CameraScreen below). Previously useVideoPlayer
// was called unconditionally at the top of CameraScreen with
// `previewUri || ''`, so on every mount of the camera screen — before
// any recording existed — the native player was initialised against
// an empty string placeholder, which crashes the native video surface.
// Extracting this into its own component means the player is created
// only once `uri` is a real file path, and is fully torn down
// (unmounted) the moment previewVisible/previewUri clears.
// =========================
const VideoPreviewScreen = React.memo(function VideoPreviewScreen({
  uri,
  onReRecord,
  onUseVideo,
  onExit,
}: {
  uri: string;
  onReRecord: () => void;
  onUseVideo: () => void;
  onExit: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    return () => {
      try { player.pause(); } catch (e) {}
    };
  }, [player]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 20 }}>
        Preview your video
      </Text>

      <VideoView
        player={player}
        style={{ width: '100%', height: 360 }}
        fullscreenOptions={{ supportsPictureInPicture: true }}
        contentFit="contain"
      />

      <View style={{ flexDirection: 'row', gap: 14, marginTop: 20 }}>
        <TouchableOpacity
          onPress={() => player.play()}
          style={{ backgroundColor: '#C4A484', paddingHorizontal: 22, paddingVertical: 11, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>▶ Play</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => player.pause()}
          style={{ backgroundColor: '#444', paddingHorizontal: 22, paddingVertical: 11, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>⏸ Pause</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', gap: 14, marginTop: 28 }}>
        <TouchableOpacity
          onPress={onReRecord}
          style={{ borderWidth: 1.5, borderColor: '#fff', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>🔄 Re-record</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onUseVideo}
          style={{ backgroundColor: '#C4A484', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>✓ Use Video</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        onPress={onExit}
        style={{ marginTop: 20, paddingHorizontal: 20, paddingVertical: 10 }}
      >
        <Text style={{ color: '#aaa', fontSize: 13 }}>✕ Cancel & go back</Text>
      </TouchableOpacity>
    </View>
  );
});

// =========================
// MAIN COMPONENT
// =========================
export default function CameraScreen() {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const isRecording = useRef(false);
  const timerRef = useRef<any>(null);

  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [torchOn, setTorchOn] = useState(false);
  const [muted, setMuted] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  const [zoom, setZoom] = useState(0);
  const lastDistance = useRef<number | null>(null);

  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    activateKeepAwakeAsync();
    return () => {
      deactivateKeepAwake();
      clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && isRecording.current) {
        stopRecording();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitCamera();
      return true;
    });
    return () => sub.remove();
  }, [previewUri]);

  if (!permission || !micPermission) return <View />;

  if (!permission.granted || !micPermission.granted) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
        <Text style={{ color: '#fff', fontSize: 16, marginBottom: 8, textAlign: 'center', paddingHorizontal: 30 }}>
          Camera and microphone permission needed
        </Text>
        <TouchableOpacity
          onPress={async () => {
            await requestPermission();
            await requestMicPermission();
          }}
          style={{ backgroundColor: '#C4A484', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8, marginTop: 16 }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const exitCamera = async () => {
    const uriToDelete = previewUri;
    setPreviewVisible(false);
    setPreviewUri(null);
    if (uriToDelete) {
      try {
        const info = await FileSystem.getInfoAsync(uriToDelete);
        if (info.exists) {
          await FileSystem.deleteAsync(uriToDelete, { idempotent: true });
          console.log('[CAM] Cleaned up abandoned preview:', uriToDelete);
        }
      } catch (e) {
        console.log('[CAM] Could not delete preview on exit:', e);
      }
    }
    router.replace('/(tabs)/add-property');
  };

  const startTimer = () => {
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const pauseTimer = () => clearInterval(timerRef.current);

  const resumeTimer = () => {
    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const stopTimer = () => {
    clearInterval(timerRef.current);
    setElapsed(0);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const toggleFacing = () => {
    if (recording) return;
    setFacing((prev) => {
      const next = prev === 'back' ? 'front' : 'back';
      if (next === 'front') setTorchOn(false);
      return next;
    });
  };

  const toggleTorch = () => {
    if (facing === 'front') return;
    setTorchOn((prev) => !prev);
  };

  const toggleMute = () => {
    // The `mute` prop on CameraView adds/removes the audio input on the
    // native capture session, so this is safe to flip before OR during
    // an active recording (test on your target devices to be sure).
    setMuted((prev) => !prev);
  };

  const handleTapFocus = (e: GestureResponderEvent) => {
    if (recording) return;
    console.log('[CAM] Tap focus at:', e.nativeEvent.locationX, e.nativeEvent.locationY);
  };

  const handlePinchZoom = (e: GestureResponderEvent) => {
    if (e.nativeEvent.touches.length !== 2) return;
    const touch1 = e.nativeEvent.touches[0];
    const touch2 = e.nativeEvent.touches[1];
    const distance = Math.sqrt(
      Math.pow(touch2.pageX - touch1.pageX, 2) +
      Math.pow(touch2.pageY - touch1.pageY, 2)
    );
    if (lastDistance.current !== null) {
      const delta = distance - lastDistance.current;
      setZoom(prev => Math.min(Math.max(prev + delta * 0.002, 0), 1));
    }
    lastDistance.current = distance;
  };

  const handleTouchEnd = () => {
    lastDistance.current = null;
  };

  const startRecording = async () => {
    if (!cameraRef.current || isRecording.current) return;

    // Auto-enable torch on recording start — back camera only, front has no flash
    if (facing === 'back' && !torchOn) {
      setTorchOn(true);
    }

    // Force the phone's camcorder mic — prevents wrong mic being picked (earpiece/Bluetooth)
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: 1,
      shouldDuckAndroid: false,
      interruptionModeAndroid: 1,
      playThroughEarpieceAndroid: false, // forces main camcorder mic on Android
    });

    isRecording.current = true;
    setRecording(true);
    setPaused(false);
    startTimer();

    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION,
        videoQuality: '480p',
        videoBitrate: 1_200_000,      // 1.2Mbps — good quality, ~27MB for 3min
        numberOfAudioChannels: 1,      // mono — significantly reduces ambient noise pickup
        audioSampleRate: 44100,        // standard sample rate for clear voice
        audioBitRate: 128000,          // 128kbps — clear voice without excess size
      });

      stopTimer();
      setRecording(false);
      setPaused(false);
      isRecording.current = false;

      if (!video?.uri) {
        console.log('[CAM] No video URI returned');
        return;
      }

      console.log('[CAM] Recorded URI:', video.uri);
      setProcessing(true);

      const fileName = `video_${Date.now()}.mp4`;
      const newPath = FileSystem.documentDirectory + fileName;
      await FileSystem.moveAsync({ from: video.uri, to: newPath });

      console.log('[CAM] Saved to:', newPath);

      setProcessing(false);
      setPreviewUri(newPath);
      setPreviewVisible(true);

    } catch (e) {
      console.log('[CAM] record error', e);
      stopTimer();
      setProcessing(false);
    }

    isRecording.current = false;
    setRecording(false);
    setPaused(false);
  };

  const stopRecording = () => {
    cameraRef.current?.stopRecording();
    // Reset audio mode back to normal after recording stops
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: false,
    });
  };

  const togglePause = async () => {
    if (!cameraRef.current || !recording) return;
    if (paused) {
      await cameraRef.current.resumeRecording();
      setPaused(false);
      resumeTimer();
    } else {
      await cameraRef.current.pauseRecording();
      setPaused(true);
      pauseTimer();
    }
  };

  const handleUseVideo = () => {
    const uriToSend = previewUri!;
    setPreviewUri(null);
    setPreviewVisible(false);
    router.replace({
      pathname: '/(tabs)/add-property',
      params: { videoUri: uriToSend },
    });
  };

  const handleReRecord = async () => {
    if (previewUri) {
      try {
        const info = await FileSystem.getInfoAsync(previewUri);
        if (info.exists) {
          await FileSystem.deleteAsync(previewUri, { idempotent: true });
          console.log('[CAM] Deleted re-recorded video:', previewUri);
        }
      } catch (e) {
        console.log('[CAM] Could not delete preview on re-record:', e);
      }
    }
    setPreviewVisible(false);
    setPreviewUri(null);
  };

  const remaining = MAX_DURATION - elapsed;
  const progress = elapsed / MAX_DURATION;

  if (processing) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#C4A484" size="large" />
        <Text style={{ color: '#fff', marginTop: 16, fontSize: 16, fontWeight: '600' }}>
          Saving video...
        </Text>
      </View>
    );
  }

  // Crash fix: VideoPreviewScreen (and its useVideoPlayer call) is only
  // ever mounted here, when previewUri is guaranteed to be a real,
  // non-null file path — never against an empty-string placeholder.
  if (previewVisible && previewUri) {
    return (
      <VideoPreviewScreen
        uri={previewUri}
        onReRecord={handleReRecord}
        onUseVideo={handleUseVideo}
        onExit={exitCamera}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <TouchableOpacity
        onPress={exitCamera}
        style={{
          position: 'absolute',
          bottom: 55,
          right: 16,
          zIndex: 10,
          backgroundColor: 'rgba(0,0,0,0.5)',
          padding: 10,
          borderRadius: 8,
        }}
      >
        <Text style={{ color: '#fff', fontWeight: 'bold' }}>✕</Text>
      </TouchableOpacity>

      {!cameraReady && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', zIndex: 5
        }}>
          <ActivityIndicator color="#C4A484" size="large" />
          <Text style={{ color: '#fff', marginTop: 12, fontSize: 14 }}>Starting camera...</Text>
        </View>
      )}

      <View
        style={{ flex: 1 }}
        onTouchEnd={handleTapFocus}
        onTouchMove={handlePinchZoom}
        onTouchEndCapture={handleTouchEnd}
      >
        <CameraView
          ref={cameraRef}
          style={{ flex: 1 }}
          mode="video"
          facing={facing}
          videoQuality="480p"
          enableTorch={torchOn}
          mute={muted}
          zoom={zoom}
          onCameraReady={() => setCameraReady(true)}
        />
      </View>

      {/* TOP CONTROLS */}
      <View style={styles.topControls}>
        <View style={styles.topControlsLeft}>
          {facing === 'back' && (
            <TouchableOpacity
              onPress={toggleTorch}
              style={[styles.iconBtn, torchOn && styles.iconBtnActive]}
            >
              <Text style={styles.iconText}>{torchOn ? '🔦' : '💡'}</Text>
              <Text style={[styles.iconLabel, torchOn && { color: '#FFD700' }]}>
                {torchOn ? 'On' : 'Off'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={toggleMute}
            style={[styles.iconBtn, muted && styles.iconBtnActive]}
          >
            <Text style={styles.iconText}>{muted ? '🔇' : '🎙️'}</Text>
            <Text style={[styles.iconLabel, muted && { color: '#FFD700' }]}>
              {muted ? 'Muted' : 'Mic'}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={toggleFacing}
          disabled={recording}
          style={[styles.iconBtn, recording && { opacity: 0.4 }]}
        >
          <Text style={styles.iconText}>🔃</Text>
          <Text style={styles.iconLabel}>{facing === 'back' ? 'Front' : 'Back'}</Text>
        </TouchableOpacity>
      </View>

      {/* QUALITY BADGE — own row, independent of the button row above so it never pushes the flip button off-screen */}
      {!recording && (
        <View style={styles.qualityBadgeRow} pointerEvents="none">
          <View style={styles.qualityBadge}>
            <Text style={styles.qualityText}>480p · 1.2Mbps · Max 3:00</Text>
          </View>
        </View>
      )}

      {/* RECORDING HUD */}
      {recording && (
        <View style={styles.hud}>
          <View style={styles.timeRow}>
            {paused ? (
              <Text style={{ color: '#FFD700', fontSize: 12, fontWeight: '700', marginRight: 8 }}>⏸ PAUSED</Text>
            ) : (
              <View style={styles.redDot} />
            )}
            <Text style={styles.timeText}>{formatTime(elapsed)}</Text>
            <Text style={styles.remainText}>  -{formatTime(remaining)}</Text>
            {muted && (
              <Text style={{ color: '#FFD700', fontSize: 12, fontWeight: '700', marginLeft: 8 }}>🔇 MUTED</Text>
            )}
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, {
              width: `${progress * 100}%`,
              backgroundColor: paused ? '#FFD700' : 'red',
            }]} />
          </View>
        </View>
      )}

      {/* REC / PAUSE / STOP */}
      <View style={styles.controls}>
        <TouchableOpacity
          onPress={startRecording}
          disabled={recording || !cameraReady}
          style={[styles.button, { backgroundColor: recording ? '#555' : (!cameraReady ? '#888' : 'red') }]}
        >
          <Text style={{ color: 'white', fontWeight: 'bold' }}>REC</Text>
        </TouchableOpacity>

        {recording && (
          <TouchableOpacity
            onPress={togglePause}
            style={[styles.button, { backgroundColor: paused ? '#4CAF50' : '#FF9800' }]}
          >
            <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 11 }}>
              {paused ? '▶ RESUME' : '⏸ PAUSE'}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={stopRecording}
          disabled={!recording}
          style={[styles.button, { backgroundColor: recording ? 'black' : '#333' }]}
        >
          <Text style={{ color: 'white', fontWeight: 'bold' }}>STOP</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topControls: {
    position: 'absolute',
    top: 55,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topControlsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  qualityBadgeRow: {
    position: 'absolute',
    top: 118,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 52,
  },
  iconBtnActive: {
    backgroundColor: 'rgba(255,215,0,0.25)',
    borderWidth: 1,
    borderColor: '#FFD700',
  },
  iconText: { fontSize: 20 },
  iconLabel: { color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2 },
  qualityBadge: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
  },
  qualityText: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  hud: { position: 'absolute', top: 120, left: 20, right: 20, alignItems: 'center' },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 10,
  },
  redDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: 'red', marginRight: 8 },
  timeText: { color: '#fff', fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  remainText: { color: '#ffaaaa', fontSize: 14, fontVariant: ['tabular-nums'] },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 2 },
  controls: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 20,
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
});