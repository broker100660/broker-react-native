import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ScrollView,
  Modal,
  Image,
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, router } from 'expo-router';
import { Picker } from '@react-native-picker/picker';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Location from 'expo-location';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as FileSystem from 'expo-file-system/legacy';
import { API_URL } from '../../config/api';

// =========================
// TYPES
// =========================
type TabType = 'RENT' | 'LAND' | 'PROPERTIES';
type VideoStatus = 'recorded' | 'uploaded_to_cloudflare' | 'saved_to_db';

type TrackedVideo = {
  uri: string;
  thumbnail: string | null;
  cloudUrl: string | null;
  status: VideoStatus;
  createdAt: number;
};
type PendingUpload = {
  videoUri: string;
  cloudUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  savedAt: number;
  tab: TabType;
};

// =========================
// NUMBER FORMATTING HELPER
// Stored state always holds raw digits only (e.g. "1500000"), which is
// what gets sent to the backend / DB. This helper is purely for what
// the broker SEES in the box while typing — it never touches state.
// =========================
const formatWithCommas = (digitsOnly: string): string => {
  if (!digitsOnly) return '';
  const num = Number(digitsOnly);
  if (Number.isNaN(num)) return '';
  return num.toLocaleString('en-US');
};

const stripToDigits = (text: string): string => text.replace(/[^0-9]/g, '');

// =========================
// VIDEO PREVIEW MODAL
// Crash fix: this component is now ONLY mounted by the parent when
// a real, non-null video URI exists (see MAIN RETURN below), so the
// native player is never initialised against a placeholder file.
// It's also wrapped in React.memo with a memoized onClose from the
// parent, so typing in the form or the upload-progress interval
// ticking every 500ms no longer forces this component to re-render
// and re-touch the native video surface.
// =========================
const VideoPreviewModal = React.memo(function VideoPreviewModal({
  visible,
  uri,
  onClose,
}: {
  visible: boolean;
  uri: string;
  onClose: () => void;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        <TouchableOpacity
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 55,
            right: 20,
            zIndex: 10,
            backgroundColor: 'rgba(255,255,255,0.15)',
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>✕ Close</Text>
        </TouchableOpacity>

        <VideoView
          player={player}
          style={{ width: '100%', height: 340 }}
          fullscreenOptions={{ supportsPictureInPicture: true }}
          allowsPictureInPicture
          contentFit="contain"
        />

        <View style={{ flexDirection: 'row', gap: 16, marginTop: 24 }}>
          <TouchableOpacity
            onPress={() => player.play()}
            style={{ backgroundColor: '#C4A484', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>▶ Play</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => player.pause()}
            style={{ backgroundColor: '#444', paddingHorizontal: 28, paddingVertical: 13, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>⏸ Pause</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
});

// =========================
// MAIN COMPONENT
// =========================
export default function AddProperty() {

  const [activeTab, setActiveTab] = useState<TabType>('RENT');
  const [broker, setBroker] = useState<any>(null);

  // LOCATION PICKERS
  const country = 'Uganda';
  const [region, setRegion] = useState('');
  const [regionId, setRegionId] = useState('');
  const [district, setDistrict] = useState('');
  const [districtId, setDistrictId] = useState('');
  const [subcounty, setSubcounty] = useState('');
  const [village, setVillage] = useState('');
  const [regions, setRegions] = useState<any[]>([]);
  const [districts, setDistricts] = useState<any[]>([]);
  const [subcounties, setSubcounties] = useState<any[]>([]);

  // GPS
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'fetching' | 'success' | 'denied' | 'error'>('idle');
  // Keep a ref so AppState handler always sees latest GPS values
  const latRef = useRef<number | null>(null);
  const lngRef = useRef<number | null>(null);

  // PROPERTY FIELDS (shared by RENT + PROPERTIES tabs)
  const [price, setPrice] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [bedroomType, setBedroomType] = useState('');
  const [toMainRoad, setToMainRoad] = useState('');
  const [transportToTown, setTransportToTown] = useState('');
  const [landlordName, setLandlordName] = useState('');
  const [landlordNumber, setLandlordNumber] = useState('');

  // PROPERTIES-FOR-SALE EXTRA FIELDS
  const [areaType, setAreaType] = useState('');           // swampy | hilly | plateau
  const [dimensionUnit, setDimensionUnit] = useState(''); // ft | decimals
  const [sizeWidth, setSizeWidth] = useState('');         // e.g. 50
  const [sizeLength, setSizeLength] = useState('');       // e.g. 100
  const [propertyUsage, setPropertyUsage] = useState(''); // has_rental_units | residential_only (PROPERTIES tab)

  // PROPERTIES-FOR-SALE — RENTAL INCOME FIELDS (shown only when
  // propertyUsage === 'has_rental_units'). Stored as raw digits only,
  // same rule as price. Maps to number_of_units / income_per_unit
  // columns on properties_for_sale.
  const [numberOfUnits, setNumberOfUnits] = useState('');
  const [incomePerUnit, setIncomePerUnit] = useState('');

  // LAND EXTRA FIELDS
  const [ownerName, setOwnerName] = useState('');
  const [ownerNumber, setOwnerNumber] = useState('');

  // VIDEO
  const [videoModal, setVideoModal] = useState(false);
  const [libraryModal, setLibraryModal] = useState(false);
  const [previewModal, setPreviewModal] = useState(false);
  const [selectedVideoByTab, setSelectedVideoByTab] = useState<Record<TabType, TrackedVideo | null>>({
    RENT: null, LAND: null, PROPERTIES: null,
  });
  const selectedVideo = selectedVideoByTab[activeTab];
  const setSelectedVideo = (video: TrackedVideo | null) => {
    setSelectedVideoByTab(prev => ({ ...prev, [activeTab]: video }));
  };
  const [savedVideos, setSavedVideos] = useState<TrackedVideo[]>([]);

  // UPLOAD
  const [uploading, setUploading] = useState(false);
  const uploadProgressRef = useRef(0);
  const [uploadProgressDisplay, setUploadProgressDisplay] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [videoCloudUrl, setVideoCloudUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const uploadingRef = useRef(false);
  const selectedVideoRef = useRef<TrackedVideo | null>(null);
  const videoCloudUrlRef = useRef<string | null>(null);

  const videoUriHandled = useRef<string | null>(null);
  // CRASH FIX: tracks whether a real video just arrived from the camera
  // screen this mount, so checkPendingUpload() (below) can skip showing
  // its "Resume Upload?" alert and potentially clobbering the fresh
  // video with a stale one. Two competing "which video is active" flows
  // racing on mount was a real state-corruption risk.
  const incomingVideoThisMount = useRef(false);

  const params = useLocalSearchParams();

  // CRASH FIX: expo-router can return a search param as a string[] instead
  // of a string in some navigation edge cases. The old code did
  // `params.videoUri as string` — a TypeScript-only cast that does NOT
  // convert anything at runtime. If videoUri ever arrived as an array,
  // that array itself got stored as TrackedVideo.uri, and later native
  // calls like FileSystem.getInfoAsync(videoUri) would receive an array
  // where they expect a string — native modules often throw at the
  // bridge level for a type mismatch like this rather than rejecting the
  // promise cleanly, which can crash the app outright. Normalizing to a
  // single string (or null) here means nothing downstream ever sees
  // anything else.
  const rawVideoUriParam = params.videoUri;
  const incomingVideoUri: string | null =
    typeof rawVideoUriParam === 'string'
      ? rawVideoUriParam
      : Array.isArray(rawVideoUriParam) && typeof rawVideoUriParam[0] === 'string'
      ? rawVideoUriParam[0]
      : null;

  // Sync refs with state
  useEffect(() => { latRef.current = latitude; }, [latitude]);
  useEffect(() => { lngRef.current = longitude; }, [longitude]);
  useEffect(() => { uploadingRef.current = uploading; }, [uploading]);
  useEffect(() => { selectedVideoRef.current = selectedVideo; }, [selectedVideo]);
  useEffect(() => { videoCloudUrlRef.current = videoCloudUrl; }, [videoCloudUrl]);

  const closePreviewModal = useCallback(() => setPreviewModal(false), []);

  // =========================
  // EFFECTS
  // =========================

  // Handle video coming back from camera screen. Now uses the
  // normalized incomingVideoUri (always a real string or null) instead
  // of the raw, possibly-array params.videoUri.
  useEffect(() => {
    if (!incomingVideoUri) return;
    if (videoUriHandled.current === incomingVideoUri) return;
    videoUriHandled.current = incomingVideoUri;
    incomingVideoThisMount.current = true;

    (async () => {
      try {
        const savedTab = await AsyncStorage.getItem('pending_tab');
        if (savedTab === 'RENT' || savedTab === 'LAND' || savedTab === 'PROPERTIES') {
          setActiveTab(savedTab as TabType);
        }
        await AsyncStorage.removeItem('pending_tab');
      } catch (e) {
        console.log('[TAB] restore error:', e);
      }

      const newVideo: TrackedVideo = {
        uri: incomingVideoUri,
        createdAt: Date.now(),
        thumbnail: null,
        cloudUrl: null,
        status: 'recorded',
      };

      setSelectedVideo(newVideo);
      setVideoCloudUrl(null);

      saveToAppFolder(newVideo).then(() => {
        clearExpoTempVideos();
      });

      captureLocation();
    })();
  }, [incomingVideoUri]);

  useEffect(() => {
    loadBroker();
    loadRegions();
    loadSavedVideos();
    cleanOrphanedVideos();
    checkPendingUpload();
    if (!incomingVideoUri) {
      clearExpoTempVideos();
    }
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'background') {
        if (uploadingRef.current && selectedVideoRef.current) {
          await savePendingUpload(
            selectedVideoRef.current.uri,
            videoCloudUrlRef.current,
            latRef.current,
            lngRef.current,
          );
        }
      }
    });
    return () => sub.remove();
  }, []);

  // =========================
  // BROKER
  // =========================
  const loadBroker = async () => {
    try {
      const data = await AsyncStorage.getItem('broker');
      if (data) setBroker(JSON.parse(data));
    } catch (e) { console.log('loadBroker error', e); }
  };

  // =========================
  // GPS
  // =========================
  const captureLocation = async () => {
    try {
      setLocationStatus('fetching');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationStatus('denied');
        return;
      }

      let loc: Location.LocationObject | null = null;

      try {
        loc = await Promise.race<Location.LocationObject>([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('GPS_TIMEOUT')), 10000)
          ),
        ]);
      } catch {
        console.log('[LOCATION] High accuracy timed out, falling back to Balanced');
        try {
          loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
        } catch (e2) {
          console.log('[LOCATION] Balanced also failed:', e2);
        }
      }

      if (loc) {
        const lat = loc.coords.latitude;
        const lng = loc.coords.longitude;
        setLatitude(lat);
        setLongitude(lng);
        latRef.current = lat;
        lngRef.current = lng;
        setLocationStatus('success');
        await AsyncStorage.setItem('last_gps', JSON.stringify({ latitude: lat, longitude: lng }));
        console.log('[LOCATION] Captured:', lat, lng);
      } else {
        throw new Error('No location obtained');
      }

    } catch (e) {
      console.log('[LOCATION] captureLocation error:', e);
      setLocationStatus('error');

      try {
        const saved = await AsyncStorage.getItem('last_gps');
        if (saved) {
          const { latitude: lat, longitude: lng } = JSON.parse(saved);
          setLatitude(lat);
          setLongitude(lng);
          latRef.current = lat;
          lngRef.current = lng;
          setLocationStatus('success');
          console.log('[LOCATION] Recovered last known GPS from storage');
        }
      } catch { /* ignore */ }
    }
  };

  // =========================
  // LOCATION PICKERS
  // =========================
  const loadRegions = async () => {
    try {
      const res = await fetch(`${API_URL}/api/regions`);
      const data = await res.json();
      setRegions(data || []);
    } catch (e) { console.log('loadRegions error', e); }
  };

  const loadDistricts = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/districts/${id}`);
      const data = await res.json();
      setDistricts(data || []);
    } catch (e) { console.log('loadDistricts error', e); }
  };

  const loadSubcounties = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/subcounties/${id}`);
      const data = await res.json();
      setSubcounties(data || []);
    } catch (e) { console.log('loadSubcounties error', e); }
  };

  // =========================
  // THUMBNAIL
  // =========================
  const generateThumbnail = async (videoUri: string): Promise<string | null> => {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, { time: 1000 });
      return uri;
    } catch (e) {
      console.log('Thumbnail error:', e);
      return null;
    }
  };

  // =========================
  // CACHE CLEANUP
  // =========================
  const clearExpoTempVideos = async () => {
    try {
      const tempDir = FileSystem.cacheDirectory + 'Camera/';
      const info = await FileSystem.getInfoAsync(tempDir);
      if (info.exists) {
        const files = await FileSystem.readDirectoryAsync(tempDir);
        for (const file of files) {
          await FileSystem.deleteAsync(tempDir + file, { idempotent: true });
        }
        if (files.length > 0) console.log(`[CACHE] Cleared ${files.length} Expo temp file(s)`);
      }
    } catch (e) { console.log('[CACHE] clearExpoTempVideos error:', e); }
  };

  const cleanOrphanedVideos = async () => {
    try {
      const data = await AsyncStorage.getItem('app_videos');
      if (!data) return;
      const videos: TrackedVideo[] = JSON.parse(data);
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const THREE_DAYS = 3 * ONE_DAY;
      const updated: TrackedVideo[] = [];
      for (const video of videos) {
        const age = now - video.createdAt;
        if (video.status === 'saved_to_db') { await safeDeleteVideo(video.uri); continue; }
        if (video.status === 'uploaded_to_cloudflare' && age > ONE_DAY) { await safeDeleteVideo(video.uri); continue; }
        if (video.status === 'recorded' && age > THREE_DAYS) { await safeDeleteVideo(video.uri); continue; }
        updated.push(video);
      }
      await AsyncStorage.setItem('app_videos', JSON.stringify(updated));
      const removed = videos.length - updated.length;
      if (removed > 0) console.log(`[CACHE] Cleaned ${removed} orphaned video(s)`);
    } catch (e) { console.log('cleanOrphanedVideos error:', e); }
  };

  const checkCacheSize = async (): Promise<boolean> => {
    try {
      const freeDisk = await FileSystem.getFreeDiskStorageAsync();
      const freeMB = freeDisk / (1024 * 1024);
      if (freeMB < 400) {
        await cleanOrphanedVideos();
        await clearExpoTempVideos();
        const freeAfter = (await FileSystem.getFreeDiskStorageAsync()) / (1024 * 1024);
        if (freeAfter < 300) {
          Alert.alert('Storage Almost Full', `Only ${freeAfter.toFixed(0)}MB free. Please submit or delete pending videos before recording.`);
          return false;
        }
      }
      return true;
    } catch (e) {
      console.log('checkCacheSize error:', e);
      return true;
    }
  };

  const safeDeleteVideo = async (uri: string) => {
    try {
      if (typeof uri !== 'string' || !uri) return;
      const isOurFile =
        uri.startsWith(FileSystem.cacheDirectory || '') ||
        uri.startsWith(FileSystem.documentDirectory || '');
      if (!isOurFile) return;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (e) { console.log('[DELETE] safeDeleteVideo error:', e); }
  };

  // =========================
  // VIDEO STATUS TRACKING
  // =========================
  const updateVideoStatus = async (uri: string, status: VideoStatus, cloudUrl?: string) => {
    try {
      const data = await AsyncStorage.getItem('app_videos');
      if (!data) return;
      const videos: TrackedVideo[] = JSON.parse(data);
      const updated = videos.map(v =>
        v.uri === uri ? { ...v, status, cloudUrl: cloudUrl || v.cloudUrl } : v
      );
      await AsyncStorage.setItem('app_videos', JSON.stringify(updated));
    } catch (e) { console.log('updateVideoStatus error:', e); }
  };

  const savePendingUpload = async (
    videoUri: string,
    cloudUrl: string | null,
    lat?: number | null,
    lng?: number | null,
  ) => {
    try {
      if (typeof videoUri !== 'string' || !videoUri) return;
      const payload: PendingUpload = {
        videoUri,
        cloudUrl,
        latitude: lat !== undefined ? lat : latRef.current,
        longitude: lng !== undefined ? lng : lngRef.current,
        savedAt: Date.now(),
        tab: activeTab,
      };
      await AsyncStorage.setItem('pending_upload', JSON.stringify(payload));
    } catch (e) { console.log('savePendingUpload error:', e); }
  };

  const clearPendingUpload = async () => {
    try { await AsyncStorage.removeItem('pending_upload'); }
    catch (e) { console.log('clearPendingUpload error:', e); }
  };

  // CRASH FIX: skips the "Resume Upload?" flow entirely if a real video
  // just arrived from the camera this mount (incomingVideoThisMount).
  // Previously both flows could fire on the same mount — the camera-
  // return effect above sets the fresh video, then this alert could
  // pop and, if "Resume" was tapped, overwrite it with stale pending
  // data, leaving refs and state out of sync in a way that could
  // surface as a crash later during upload/submit. Also now guards
  // against a malformed pending.videoUri (non-string) before it ever
  // reaches FileSystem/native calls.
  const checkPendingUpload = async () => {
    try {
      if (incomingVideoThisMount.current) return;

      const data = await AsyncStorage.getItem('pending_upload');
      if (!data) return;
      const pending: PendingUpload = JSON.parse(data);

      if (typeof pending?.videoUri !== 'string' || !pending.videoUri) {
        await clearPendingUpload();
        return;
      }

      const info = await FileSystem.getInfoAsync(pending.videoUri);
      if (!info.exists) { await clearPendingUpload(); return; }

      Alert.alert(
        'Resume Upload?',
        'You have an unfinished property upload. Would you like to continue?',
        [
          {
            text: 'Resume',
            onPress: async () => {
              const thumb = await generateThumbnail(pending.videoUri);
              const video: TrackedVideo = {
                uri: pending.videoUri,
                thumbnail: thumb,
                cloudUrl: pending.cloudUrl || null,
                status: pending.cloudUrl ? 'uploaded_to_cloudflare' : 'recorded',
                createdAt: Date.now(),
              };
              setActiveTab(pending.tab);
              setSelectedVideoByTab(prev => ({ ...prev, [pending.tab]: video }));

              if (pending.cloudUrl) {
                setVideoCloudUrl(pending.cloudUrl);
                videoCloudUrlRef.current = pending.cloudUrl;
              }

              if (pending.latitude != null && pending.longitude != null) {
                setLatitude(pending.latitude);
                setLongitude(pending.longitude);
                latRef.current = pending.latitude;
                lngRef.current = pending.longitude;
                setLocationStatus('success');
                console.log('[RESUME] Restored GPS:', pending.latitude, pending.longitude);
              }
            },
          },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: async () => {
              await safeDeleteVideo(pending.videoUri);
              await clearPendingUpload();
            },
          },
        ]
      );
    } catch (e) { console.log('checkPendingUpload error:', e); }
  };

  // =========================
  // SAVED VIDEOS
  // =========================
  const loadSavedVideos = async () => {
    try {
      const data = await AsyncStorage.getItem('app_videos');
      if (data) setSavedVideos(JSON.parse(data));
    } catch (e) { console.log('loadSavedVideos error', e); }
  };

  const saveToAppFolder = async (video: TrackedVideo): Promise<void> => {
    if (!video?.uri || typeof video.uri !== 'string') return;
    try {
      const thumb = await generateThumbnail(video.uri);
      const newVideo: TrackedVideo = {
        uri: video.uri,
        thumbnail: thumb,
        cloudUrl: null,
        status: 'recorded',
        createdAt: Date.now(),
      };
      const existing = await AsyncStorage.getItem('app_videos');
      const list: TrackedVideo[] = existing ? JSON.parse(existing) : [];
      const noDuplicates = list.filter(v => v.uri !== video.uri);
      const updated = [...noDuplicates, newVideo];
      await AsyncStorage.setItem('app_videos', JSON.stringify(updated));
      setSavedVideos(updated);
      setSelectedVideo({ ...newVideo });
      selectedVideoRef.current = { ...newVideo };
    } catch (e) { console.log('saveToAppFolder error', e); }
  };

  const deleteFromAppFolder = (index: number) => {
    const video = savedVideos[index];
    Alert.alert('Delete Video', 'Remove this video from your app library?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            if (video.status !== 'saved_to_db') await safeDeleteVideo(video.uri);
            const updated = savedVideos.filter((_, i) => i !== index);
            await AsyncStorage.setItem('app_videos', JSON.stringify(updated));
            setSavedVideos(updated);
            if (selectedVideo?.uri === video.uri) {
              setSelectedVideo(null);
              selectedVideoRef.current = null;
              setVideoCloudUrl(null);
              videoCloudUrlRef.current = null;
            }
          } catch (e) { console.log('deleteFromAppFolder error', e); }
        },
      },
    ]);
  };

  const selectFromAppFolder = async (video: TrackedVideo) => {
    try {
      if (typeof video?.uri === 'string' && video.uri.startsWith('file://')) {
        const info = await FileSystem.getInfoAsync(video.uri);
        if (!info.exists) {
          Alert.alert(
            'Video Not Found',
            'This video no longer exists on your device.',
            [
              {
                text: 'Remove from library',
                style: 'destructive',
                onPress: async () => {
                  const updated = savedVideos.filter(v => v.uri !== video.uri);
                  await AsyncStorage.setItem('app_videos', JSON.stringify(updated));
                  setSavedVideos(updated);
                },
              },
              { text: 'OK', style: 'cancel' },
            ]
          );
          return;
        }
      }
    } catch (e) {
      console.log('[SELECT] file check error:', e);
    }

    setSelectedVideo(video);
    selectedVideoRef.current = video;
    setVideoCloudUrl(video.cloudUrl);
    videoCloudUrlRef.current = video.cloudUrl;
    setLibraryModal(false);
    setVideoModal(false);
  };

  // =========================
  // GALLERY PICKER
  // =========================
  const pickVideoFromGallery = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Needed', 'Allow gallery access.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 1,
      });

      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      const video: TrackedVideo = {
        uri: asset.uri,
        thumbnail: null,
        cloudUrl: null,
        status: 'recorded',
        createdAt: Date.now(),
      };

      setSelectedVideo(video);
      selectedVideoRef.current = video;
      setVideoCloudUrl(null);
      videoCloudUrlRef.current = null;
      captureLocation();

    } catch (e) {
      console.log('[GALLERY ERROR]', e);
    }
  };

  // =========================
  // UPLOAD
  // =========================
  const setProgress = (value: number) => {
    const clamped = Math.min(Math.max(Math.round(value), 0), 100);
    uploadProgressRef.current = clamped;
    setUploadProgressDisplay(clamped);
  };

  const uploadVideoToCloudflare = async (): Promise<string | null> => {
    const videoUri = selectedVideoRef.current?.uri;
    if (typeof videoUri !== 'string' || !videoUri) return null;

    try {
      setUploading(true);
      uploadingRef.current = true;
      setProgress(0);
      setUploadStatus('Preparing video...');

      const fileInfo = await FileSystem.getInfoAsync(videoUri);
      if (!fileInfo.exists) {
        Alert.alert('Video Not Found', 'Please select the video again.');
        setUploading(false);
        uploadingRef.current = false;
        return null;
      }

      const fileSize = (fileInfo as any).size;
      if (!fileSize || fileSize === 0) {
        Alert.alert('Empty Video', 'The video file appears to be empty.');
        setUploading(false);
        uploadingRef.current = false;
        return null;
      }

      setUploadStatus('Getting upload URL...');
      const urlRes = await fetch(`${API_URL}/api/videos/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSize }),
      });

      const urlData = JSON.parse(await urlRes.text());
      if (!urlRes.ok) {
        Alert.alert('Upload Error', `Failed to get upload URL: ${urlData.error}`);
        setUploading(false);
        uploadingRef.current = false;
        return null;
      }

      await savePendingUpload(videoUri, null, latRef.current, lngRef.current);
      setUploadStatus('Uploading...');

      let fakeProgress = 0;
      let progressInterval: ReturnType<typeof setInterval> | undefined;
      let uploadResult: any;

      try {
        progressInterval = setInterval(() => {
          fakeProgress = Math.min(fakeProgress + 2, 90);
          setProgress(fakeProgress);
          setUploadStatus(`Uploading... ${fakeProgress}%`);
        }, 500);

        uploadResult = await FileSystem.uploadAsync(urlData.uploadURL, videoUri, {
          httpMethod: 'PATCH',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            'Content-Type': 'application/offset+octet-stream',
            'Content-Length': String(fileSize),
            'Upload-Offset': '0',
            'Tus-Resumable': '1.0.0',
          },
        });
      } finally {
        if (progressInterval !== undefined) clearInterval(progressInterval);
      }

      console.log('[UPLOAD] status:', uploadResult.status);

      if (uploadResult.status !== 204 && uploadResult.status !== 200) {
        Alert.alert('Upload Failed', `Status ${uploadResult.status}: ${uploadResult.body}`);
        setUploading(false);
        uploadingRef.current = false;
        setProgress(0);
        setUploadStatus('');
        return null;
      }

      setProgress(100);
      setUploadStatus('✓ Upload complete!');
      setUploading(false);
      uploadingRef.current = false;

      const previewUrl = urlData.watchUrl;
      setVideoCloudUrl(previewUrl);
      videoCloudUrlRef.current = previewUrl;

      await updateVideoStatus(videoUri, 'uploaded_to_cloudflare', previewUrl);
      await savePendingUpload(videoUri, previewUrl, latRef.current, lngRef.current);

      return previewUrl;

    } catch (e: any) {
      console.log('[UPLOAD] ERROR:', e?.message);
      Alert.alert('Upload Failed', e?.message || 'Unknown error');
      setUploading(false);
      uploadingRef.current = false;
      setProgress(0);
      setUploadStatus('');
      return null;
    }
  };

  // =========================
  // SUBMIT PROPERTY (RENT)
  // =========================
  const submitProperty = async () => {
    if (!broker) return Alert.alert('Error', 'No broker found. Please log in again.');
    if (!selectedVideo) return Alert.alert('Error', 'Please select a video first.');

    let cloudUrl = videoCloudUrlRef.current;
    if (!cloudUrl) {
      cloudUrl = await uploadVideoToCloudflare();
      if (!cloudUrl) return;
    }

    try {
      setSubmitting(true);

      const body = {
        brokerId: broker.id,
        country, region, district, subcounty, village,
        price, propertyType, bedroomType,
        videoURL: cloudUrl,
        latitude: latRef.current,
        longitude: lngRef.current,
        landlord_name: landlordName,
        landlord_number: landlordNumber,
        to_main_road: toMainRoad,
        transport_to_town: transportToTown,
      };

      const res = await fetch(`${API_URL}/properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const resText = await res.text();
      if (resText.trim().startsWith('<')) {
        Alert.alert('Error', 'Server error saving property. Please try again.');
        return;
      }

      const data = JSON.parse(resText);
      if (!res.ok) {
        Alert.alert('Error', data.error || 'Failed to save property.');
        return;
      }

      await updateVideoStatus(selectedVideo.uri, 'saved_to_db');
      await safeDeleteVideo(selectedVideo.uri);
      await clearPendingUpload();

      Alert.alert('Success', 'Property uploaded successfully!');
      resetForm();

    } catch (e: any) {
      Alert.alert('Network Error', e?.message || 'Please check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // =========================
  // RESET FORM
  // =========================
  const resetForm = () => {
    setSelectedVideo(null);
    selectedVideoRef.current = null;
    setVideoCloudUrl(null);
    videoCloudUrlRef.current = null;
    setProgress(0);
    setUploadStatus('');
    setLatitude(null);
    setLongitude(null);
    latRef.current = null;
    lngRef.current = null;
    setLocationStatus('idle');
    setPrice('');
    setPropertyType('');
    setBedroomType('');
    setRegion('');
    setRegionId('');
    setDistrict('');
    setDistrictId('');
    setSubcounty('');
    setVillage('');
    setDistricts([]);
    setSubcounties([]);
    setLandlordName('');
    setLandlordNumber('');
    setToMainRoad('');
    setTransportToTown('');
    setAreaType('');
    setDimensionUnit('');
    setSizeWidth('');
    setSizeLength('');
    setPropertyUsage('');
    setNumberOfUnits('');
    setIncomePerUnit('');
    setOwnerName('');
    setOwnerNumber('');
    videoUriHandled.current = null;
    incomingVideoThisMount.current = false;
  };

  // =========================
  // RENDER HELPERS
  // =========================
  const renderComingSoon = (label: string) => (
    <View style={styles.comingSoon}>
      <Text style={styles.comingSoonText}>{label} — Coming Soon</Text>
    </View>
  );

  const renderVideoBox = () => {
    if (uploading) {
      const pct = uploadProgressDisplay;
      return (
        <View style={[styles.uploadBox, { height: 180, justifyContent: 'center', paddingHorizontal: 24, borderStyle: 'solid' }]}>
          <Text style={{ color: '#C4A484', fontWeight: '700', fontSize: 28, marginBottom: 10, textAlign: 'center' }}>
            {pct}%
          </Text>
          <View style={{ width: '100%', height: 10, backgroundColor: '#e0d5cc', borderRadius: 5, overflow: 'hidden', marginBottom: 12 }}>
            <View style={{ width: `${pct}%`, height: '100%', backgroundColor: '#C4A484', borderRadius: 5 }} />
          </View>
          <Text style={{ color: uploadStatus.includes('Retry') || uploadStatus.includes('issue') ? '#FF9800' : '#888', fontSize: 12, textAlign: 'center', marginBottom: 8 }}>
            {uploadStatus}
          </Text>
          {pct < 100 && <ActivityIndicator color="#C4A484" size="small" />}
        </View>
      );
    }

    if (selectedVideo) {
      return (
        <View style={{ marginBottom: 16 }}>
          <TouchableOpacity
            style={[styles.uploadBox, { height: 160, padding: 0, overflow: 'hidden' }]}
            onPress={() => setPreviewModal(true)}
          >
            {selectedVideo.thumbnail ? (
              <>
                <Image source={{ uri: selectedVideo.thumbnail }} style={{ width: '100%', height: '100%', borderRadius: 8 }} resizeMode="cover" />
                <View style={styles.playOverlay}>
                  <View style={styles.playButton}>
                    <Text style={{ color: '#fff', fontSize: 18, marginLeft: 3 }}>▶</Text>
                  </View>
                </View>
              </>
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 32 }}>🎬</Text>
                <Text style={{ color: '#666', marginTop: 6 }}>Video Selected — tap to preview</Text>
              </View>
            )}
          </TouchableOpacity>

          <View style={styles.videoStatusRow}>
            {videoCloudUrl ? (
              <View style={styles.uploadedBadge}>
                <View style={styles.greenDot} />
                <Text style={styles.uploadedText}>Uploaded to Cloudflare</Text>
              </View>
            ) : (
              <View style={styles.pendingBadge}>
                <View style={styles.orangeDot} />
                <Text style={styles.pendingText}>Not yet uploaded</Text>
              </View>
            )}
            <TouchableOpacity onPress={() => setVideoModal(true)}>
              <Text style={styles.changeText}>Change</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.videoStatusRow}>
            {locationStatus === 'fetching' && (
              <View style={styles.pendingBadge}>
                <ActivityIndicator color="#FF9800" size="small" />
                <Text style={styles.pendingText}>  Getting GPS location...</Text>
              </View>
            )}
            {locationStatus === 'success' && (
              <View style={styles.uploadedBadge}>
                <View style={styles.greenDot} />
                <Text style={styles.uploadedText}>📍 Location captured</Text>
              </View>
            )}
            {(locationStatus === 'denied' || locationStatus === 'error') && (
              <TouchableOpacity style={styles.pendingBadge} onPress={captureLocation}>
                <View style={styles.orangeDot} />
                <Text style={styles.pendingText}>📍 Location unavailable — tap to retry</Text>
              </TouchableOpacity>
            )}
            {locationStatus === 'idle' && <View />}
          </View>

          {!videoCloudUrl && (
            <TouchableOpacity style={styles.uploadNowButton} onPress={uploadVideoToCloudflare}>
              <Text style={styles.uploadNowText}>⬆ Upload Video Now</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    return (
      <TouchableOpacity style={styles.uploadBox} onPress={() => setVideoModal(true)}>
        <Text style={{ fontSize: 32 }}>🎥</Text>
        <Text style={{ color: '#999', marginTop: 8 }}>Tap to select or record video</Text>
      </TouchableOpacity>
    );
  };

  const renderRentForm = () => (
    <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Upload Property</Text>

      {renderVideoBox()}

      <Text style={styles.sectionLabel}>Country: Uganda</Text>

      <Text style={styles.label}>Region</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={region}
          onValueChange={(v) => {
            const found = regions.find(r => r.name === v);
            setRegion(v);
            setRegionId(found?.id || '');
            setDistrict(''); setDistrictId('');
            setSubcounty('');
            setDistricts([]); setSubcounties([]);
            if (found?.id) loadDistricts(found.id);
          }}
        >
          <Picker.Item label="Select Region" value="" />
          {regions.map((r) => <Picker.Item key={r.id} label={r.name} value={r.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>District</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={district}
          onValueChange={(v) => {
            const found = districts.find(d => d.name === v);
            setDistrict(v);
            setDistrictId(found?.id || '');
            setSubcounty('');
            setSubcounties([]);
            if (found?.id) loadSubcounties(found.id);
          }}
        >
          <Picker.Item label="Select District" value="" />
          {districts.map((d) => <Picker.Item key={d.id} label={d.name} value={d.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Subcounty</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={subcounty} onValueChange={(v) => setSubcounty(v)}>
          <Picker.Item label="Select Subcounty" value="" />
          {subcounties.map((s) => <Picker.Item key={s.id} label={s.name} value={s.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Village</Text>
      <TextInput style={styles.input} value={village} onChangeText={setVillage} placeholder="Enter village" />

      <Text style={styles.label}>Price (UGX)</Text>
      <TextInput
        style={styles.input}
        value={formatWithCommas(price)}
        onChangeText={(text) => setPrice(stripToDigits(text))}
        keyboardType="numeric"
        placeholder="Enter price"
      />

      <Text style={styles.label}>Property Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={propertyType} onValueChange={setPropertyType}>
          <Picker.Item label="Select Type" value="" />
          <Picker.Item label="Apartment" value="apartment" />
          <Picker.Item label="Standalone" value="standalone" />
          <Picker.Item label="Rental" value="rental" />
        </Picker>
      </View>

      <Text style={styles.label}>Bedroom Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={bedroomType} onValueChange={setBedroomType}>
          <Picker.Item label="Select Bedroom Type" value="" />
          <Picker.Item label="Single Room" value="single_room" />
          <Picker.Item label="Studio" value="studio_room" />
          <Picker.Item label="Double Room" value="double_room" />
          <Picker.Item label="2 Bedrooms" value="two_bedroom" />
          <Picker.Item label="3 Bedrooms" value="three_bedroom" />
          <Picker.Item label="4 Bedrooms" value="four_bedroom" />
          <Picker.Item label="5 Bedrooms" value="five_bedroom" />
          <Picker.Item label="6 Bedrooms" value="six_bedroom" />
          <Picker.Item label="7 Bedrooms" value="seven_bedroom" />
        </Picker>
      </View>

      <Text style={styles.label}>To Main Road</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={toMainRoad} onValueChange={setToMainRoad}>
          <Picker.Item label="Select Distance" value="" />
          <Picker.Item label="1 min walk" value="1_min" />
          <Picker.Item label="2 min walk" value="2_min" />
          <Picker.Item label="3 min walk" value="3_min" />
          <Picker.Item label="4 min walk" value="4_min" />
          <Picker.Item label="5 min walk" value="5_min" />
          <Picker.Item label="1k boda" value="1000_boda" />
          <Picker.Item label="2k boda" value="2000_boda" />
          <Picker.Item label="3k boda" value="3000_boda" />
          <Picker.Item label="4k boda" value="4000_boda" />
          <Picker.Item label="5k boda" value="5000_boda" />
        </Picker>
      </View>

      <Text style={styles.label}>Transport to Town</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={transportToTown} onValueChange={setTransportToTown}>
          <Picker.Item label="Select Transport Cost" value="" />
          <Picker.Item label="1k taxi" value="1000" />
          <Picker.Item label="2k taxi" value="2000" />
          <Picker.Item label="3k taxi" value="3000" />
          <Picker.Item label="4k taxi" value="4000" />
          <Picker.Item label="5k taxi" value="5000" />
        </Picker>
      </View>

      <Text style={styles.label}>Landlord Name</Text>
      <TextInput style={styles.input} value={landlordName} onChangeText={setLandlordName} placeholder="Enter landlord name" />

      <Text style={styles.label}>Landlord Number</Text>
      <TextInput style={styles.input} value={landlordNumber} onChangeText={setLandlordNumber} keyboardType="phone-pad" placeholder="Enter landlord number" />

      <TouchableOpacity
        style={[styles.button, (submitting || uploading) && { opacity: 0.6 }]}
        onPress={submitProperty}
        disabled={submitting || uploading}
      >
        {submitting ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.buttonText}>Saving property...</Text>
          </View>
        ) : (
          <Text style={styles.buttonText}>Upload Property</Text>
        )}
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // =========================
  // SUBMIT PROPERTY FOR SALE
  // =========================
  const submitPropertyForSale = async () => {
    if (!broker) return Alert.alert('Error', 'No broker found. Please log in again.');
    if (!selectedVideo) return Alert.alert('Error', 'Please select a video first.');
    if (!propertyUsage) return Alert.alert('Required', 'Please select whether the property has rental units or is residential only.');
    if (propertyUsage === 'has_rental_units' && (!numberOfUnits || !incomePerUnit)) {
      return Alert.alert('Required', 'Please enter the number of units and income per unit.');
    }

    let cloudUrl = videoCloudUrlRef.current;
    if (!cloudUrl) {
      cloudUrl = await uploadVideoToCloudflare();
      if (!cloudUrl) return;
    }

    try {
      setSubmitting(true);

      const body = {
        brokerId: broker.id,
        country, region, district, subcounty, village,
        price, propertyType, bedroomType,
        areaType,
        dimensionUnit,
        sizeWidth,
        sizeLength,
        propertyUsage,
        number_of_units: propertyUsage === 'has_rental_units' ? numberOfUnits : null,
        income_per_unit: propertyUsage === 'has_rental_units' ? incomePerUnit : null,
        videoURL: cloudUrl,
        latitude: latRef.current,
        longitude: lngRef.current,
        landlord_name: landlordName,
        landlord_number: landlordNumber,
        to_main_road: toMainRoad,
        transport_to_town: transportToTown,
      };

      const res = await fetch(`${API_URL}/properties-for-sale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const resText = await res.text();
      if (resText.trim().startsWith('<')) {
        Alert.alert('Error', 'Server error saving property. Please try again.');
        return;
      }

      const data = JSON.parse(resText);
      if (!res.ok) {
        Alert.alert('Error', data.error || 'Failed to save property.');
        return;
      }

      await updateVideoStatus(selectedVideo.uri, 'saved_to_db');
      await safeDeleteVideo(selectedVideo.uri);
      await clearPendingUpload();

      Alert.alert('Success', 'Property for sale uploaded successfully!');
      resetForm();

    } catch (e: any) {
      Alert.alert('Network Error', e?.message || 'Please check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // =========================
  // SUBMIT LAND
  // =========================
  const submitLandProperty = async () => {
    if (!broker) return Alert.alert('Error', 'No broker found. Please log in again.');
    if (!selectedVideo) return Alert.alert('Error', 'Please select a video first.');
    if (!propertyType) return Alert.alert('Required', 'Please select whether this is a Plot or an Estate.');
    if (!propertyUsage) return Alert.alert('Required', 'Please select the land usage.');

    let cloudUrl = videoCloudUrlRef.current;
    if (!cloudUrl) {
      cloudUrl = await uploadVideoToCloudflare();
      if (!cloudUrl) return;
    }

    try {
      setSubmitting(true);

      const body = {
        brokerId: broker.id,
        country, region, district, subcounty, village,
        price,
        propertyType,
        propertyUsage,
        areaType,
        dimensionUnit,
        sizeWidth,
        sizeLength,
        videoURL: cloudUrl,
        latitude: latRef.current,
        longitude: lngRef.current,
        owner_name: ownerName,
        owner_number: ownerNumber,
        to_main_road: toMainRoad,
        transport_to_town: transportToTown,
      };

      const res = await fetch(`${API_URL}/land-properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const resText = await res.text();
      if (resText.trim().startsWith('<')) {
        Alert.alert('Error', 'Server error saving land. Please try again.');
        return;
      }

      const data = JSON.parse(resText);
      if (!res.ok) {
        Alert.alert('Error', data.error || 'Failed to save land.');
        return;
      }

      await updateVideoStatus(selectedVideo.uri, 'saved_to_db');
      await safeDeleteVideo(selectedVideo.uri);
      await clearPendingUpload();

      Alert.alert('Success', 'Land uploaded successfully!');
      resetForm();

    } catch (e: any) {
      Alert.alert('Network Error', e?.message || 'Please check your connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // =========================
  // PROPERTIES FOR SALE FORM
  // =========================
  const renderPropertiesForm = () => (
    <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Property For Sale</Text>

      {renderVideoBox()}

      <Text style={styles.sectionLabel}>Country: Uganda</Text>

      <Text style={styles.label}>Region</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={region}
          onValueChange={(v) => {
            const found = regions.find(r => r.name === v);
            setRegion(v);
            setRegionId(found?.id || '');
            setDistrict(''); setDistrictId('');
            setSubcounty('');
            setDistricts([]); setSubcounties([]);
            if (found?.id) loadDistricts(found.id);
          }}
        >
          <Picker.Item label="Select Region" value="" />
          {regions.map((r) => <Picker.Item key={r.id} label={r.name} value={r.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>District</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={district}
          onValueChange={(v) => {
            const found = districts.find(d => d.name === v);
            setDistrict(v);
            setDistrictId(found?.id || '');
            setSubcounty('');
            setSubcounties([]);
            if (found?.id) loadSubcounties(found.id);
          }}
        >
          <Picker.Item label="Select District" value="" />
          {districts.map((d) => <Picker.Item key={d.id} label={d.name} value={d.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Subcounty</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={subcounty} onValueChange={(v) => setSubcounty(v)}>
          <Picker.Item label="Select Subcounty" value="" />
          {subcounties.map((s) => <Picker.Item key={s.id} label={s.name} value={s.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Village</Text>
      <TextInput style={styles.input} value={village} onChangeText={setVillage} placeholder="Enter village" />

      <Text style={styles.label}>Price (UGX)</Text>
      <TextInput
        style={styles.input}
        value={formatWithCommas(price)}
        onChangeText={(text) => setPrice(stripToDigits(text))}
        keyboardType="numeric"
        placeholder="Enter price"
      />

      <Text style={styles.label}>Area Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={areaType} onValueChange={setAreaType}>
          <Picker.Item label="Select Area Type" value="" />
          <Picker.Item label="Swampy" value="swampy" />
          <Picker.Item label="Hilly" value="hilly" />
          <Picker.Item label="Plateau" value="plateau" />
        </Picker>
      </View>

      <Text style={styles.label}>Dimension Unit</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={dimensionUnit} onValueChange={setDimensionUnit}>
          <Picker.Item label="Select Unit" value="" />
          <Picker.Item label="Feet (ft)" value="ft" />
          <Picker.Item label="Decimals" value="decimals" />
        </Picker>
      </View>

      <Text style={styles.label}>
        Size {dimensionUnit ? `(${dimensionUnit})` : ''} — Width × Length
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 4 }}>
        <TextInput
          style={[styles.input, { flex: 1, marginBottom: 0 }]}
          value={sizeWidth}
          onChangeText={setSizeWidth}
          keyboardType="numeric"
          placeholder="Width"
        />
        <View style={{ justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontWeight: '700', fontSize: 16 }}>×</Text>
        </View>
        <TextInput
          style={[styles.input, { flex: 1, marginBottom: 0 }]}
          value={sizeLength}
          onChangeText={setSizeLength}
          keyboardType="numeric"
          placeholder="Length"
        />
      </View>
      {sizeWidth && sizeLength ? (
        <Text style={{ color: '#C4A484', fontSize: 12, marginBottom: 4 }}>
          {sizeWidth} × {sizeLength} {dimensionUnit || ''}
        </Text>
      ) : null}

      <Text style={styles.label}>Property Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={propertyType} onValueChange={setPropertyType}>
          <Picker.Item label="Select Type" value="" />
          <Picker.Item label="Apartment" value="apartment" />
          <Picker.Item label="Standalone" value="standalone" />
          <Picker.Item label="Rental" value="rental" />
        </Picker>
      </View>

      <Text style={styles.label}>
        Property Usage <Text style={{ color: '#e53935' }}>*</Text>
      </Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={propertyUsage}
          onValueChange={(v) => {
            setPropertyUsage(v);
            // Clear rental-income fields whenever the broker switches
            // away from "has_rental_units" so stale numbers never
            // silently ride along on submit.
            if (v !== 'has_rental_units') {
              setNumberOfUnits('');
              setIncomePerUnit('');
            }
          }}
        >
          <Picker.Item label="Select Usage" value="" />
          <Picker.Item label="Has Rental Units (tenants can rent inside)" value="has_rental_units" />
          <Picker.Item label="Residential Only (home to sleep in)" value="residential_only" />
        </Picker>
      </View>
      {!propertyUsage ? (
        <Text style={{ color: '#aaa', fontSize: 11, marginBottom: 4, marginTop: -2 }}>
          Required — helps buyers know if this property earns rental income
        </Text>
      ) : null}

      {propertyUsage === 'has_rental_units' && (
        <>
          <Text style={styles.label}>
            Number of Units <Text style={{ color: '#e53935' }}>*</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={numberOfUnits}
            onChangeText={(text) => setNumberOfUnits(stripToDigits(text))}
            keyboardType="numeric"
            placeholder="e.g. 4"
          />

          <Text style={styles.label}>
            Income per Unit (UGX/month) <Text style={{ color: '#e53935' }}>*</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={formatWithCommas(incomePerUnit)}
            onChangeText={(text) => setIncomePerUnit(stripToDigits(text))}
            keyboardType="numeric"
            placeholder="e.g. 300,000"
          />
        </>
      )}

      <Text style={styles.label}>Bedroom Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={bedroomType} onValueChange={setBedroomType}>
          <Picker.Item label="Select Bedroom Type" value="" />
          <Picker.Item label="Single Room" value="single_room" />
          <Picker.Item label="Studio" value="studio_room" />
          <Picker.Item label="Double Room" value="double_room" />
          <Picker.Item label="2 Bedrooms" value="two_bedroom" />
          <Picker.Item label="3 Bedrooms" value="three_bedroom" />
          <Picker.Item label="4 Bedrooms" value="four_bedroom" />
          <Picker.Item label="5 Bedrooms" value="five_bedroom" />
          <Picker.Item label="6 Bedrooms" value="six_bedroom" />
          <Picker.Item label="7 Bedrooms" value="seven_bedroom" />
        </Picker>
      </View>

      <Text style={styles.label}>To Main Road</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={toMainRoad} onValueChange={setToMainRoad}>
          <Picker.Item label="Select Distance" value="" />
          <Picker.Item label="1 min walk" value="1_min" />
          <Picker.Item label="2 min walk" value="2_min" />
          <Picker.Item label="3 min walk" value="3_min" />
          <Picker.Item label="4 min walk" value="4_min" />
          <Picker.Item label="5 min walk" value="5_min" />
          <Picker.Item label="1k boda" value="1000_boda" />
          <Picker.Item label="2k boda" value="2000_boda" />
          <Picker.Item label="3k boda" value="3000_boda" />
          <Picker.Item label="4k boda" value="4000_boda" />
          <Picker.Item label="5k boda" value="5000_boda" />
        </Picker>
      </View>

      <Text style={styles.label}>Transport to Town</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={transportToTown} onValueChange={setTransportToTown}>
          <Picker.Item label="Select Transport Cost" value="" />
          <Picker.Item label="1k taxi" value="1000" />
          <Picker.Item label="2k taxi" value="2000" />
          <Picker.Item label="3k taxi" value="3000" />
          <Picker.Item label="4k taxi" value="4000" />
          <Picker.Item label="5k taxi" value="5000" />
        </Picker>
      </View>

      <Text style={styles.label}>Landlord Name</Text>
      <TextInput style={styles.input} value={landlordName} onChangeText={setLandlordName} placeholder="Enter landlord name" />

      <Text style={styles.label}>Landlord Number</Text>
      <TextInput style={styles.input} value={landlordNumber} onChangeText={setLandlordNumber} keyboardType="phone-pad" placeholder="Enter landlord number" />

      <TouchableOpacity
        style={[styles.button, (submitting || uploading) && { opacity: 0.6 }]}
        onPress={submitPropertyForSale}
        disabled={submitting || uploading}
      >
        {submitting ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.buttonText}>Saving property...</Text>
          </View>
        ) : (
          <Text style={styles.buttonText}>Upload Property For Sale</Text>
        )}
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // =========================
  // LAND FORM
  // =========================
  const renderLandForm = () => (
    <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Upload Land</Text>

      {renderVideoBox()}

      <Text style={styles.sectionLabel}>Country: Uganda</Text>

      <Text style={styles.label}>Region</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={region}
          onValueChange={(v) => {
            const found = regions.find(r => r.name === v);
            setRegion(v);
            setRegionId(found?.id || '');
            setDistrict(''); setDistrictId('');
            setSubcounty('');
            setDistricts([]); setSubcounties([]);
            if (found?.id) loadDistricts(found.id);
          }}
        >
          <Picker.Item label="Select Region" value="" />
          {regions.map((r) => <Picker.Item key={r.id} label={r.name} value={r.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>District</Text>
      <View style={styles.pickerWrapper}>
        <Picker
          mode="dropdown"
          selectedValue={district}
          onValueChange={(v) => {
            const found = districts.find(d => d.name === v);
            setDistrict(v);
            setDistrictId(found?.id || '');
            setSubcounty('');
            setSubcounties([]);
            if (found?.id) loadSubcounties(found.id);
          }}
        >
          <Picker.Item label="Select District" value="" />
          {districts.map((d) => <Picker.Item key={d.id} label={d.name} value={d.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Subcounty</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={subcounty} onValueChange={(v) => setSubcounty(v)}>
          <Picker.Item label="Select Subcounty" value="" />
          {subcounties.map((s) => <Picker.Item key={s.id} label={s.name} value={s.name} />)}
        </Picker>
      </View>

      <Text style={styles.label}>Village</Text>
      <TextInput style={styles.input} value={village} onChangeText={setVillage} placeholder="Enter village" />

      <Text style={styles.label}>Price (UGX)</Text>
      <TextInput
        style={styles.input}
        value={formatWithCommas(price)}
        onChangeText={(text) => setPrice(stripToDigits(text))}
        keyboardType="numeric"
        placeholder="Enter price"
      />

      <Text style={styles.label}>Area Type</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={areaType} onValueChange={setAreaType}>
          <Picker.Item label="Select Area Type" value="" />
          <Picker.Item label="Swampy" value="swampy" />
          <Picker.Item label="Hilly" value="hilly" />
          <Picker.Item label="Plateau" value="plateau" />
        </Picker>
      </View>

      <Text style={styles.label}>Dimension Unit</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={dimensionUnit} onValueChange={setDimensionUnit}>
          <Picker.Item label="Select Unit" value="" />
          <Picker.Item label="Feet (ft)" value="ft" />
          <Picker.Item label="Decimals" value="decimals" />
        </Picker>
      </View>

      <Text style={styles.label}>
        Size {dimensionUnit ? `(${dimensionUnit})` : ''} — Width × Length
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 4 }}>
        <TextInput
          style={[styles.input, { flex: 1, marginBottom: 0 }]}
          value={sizeWidth}
          onChangeText={setSizeWidth}
          keyboardType="numeric"
          placeholder="Width"
        />
        <View style={{ justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontWeight: '700', fontSize: 16 }}>×</Text>
        </View>
        <TextInput
          style={[styles.input, { flex: 1, marginBottom: 0 }]}
          value={sizeLength}
          onChangeText={setSizeLength}
          keyboardType="numeric"
          placeholder="Length"
        />
      </View>
      {sizeWidth && sizeLength ? (
        <Text style={{ color: '#C4A484', fontSize: 12, marginBottom: 4 }}>
          {sizeWidth} × {sizeLength} {dimensionUnit || ''}
        </Text>
      ) : null}

      <Text style={styles.label}>
        Property Type <Text style={{ color: '#e53935' }}>*</Text>
      </Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={propertyType} onValueChange={setPropertyType}>
          <Picker.Item label="Select Type" value="" />
          <Picker.Item label="Plot" value="plot" />
          <Picker.Item label="Estate" value="estate" />
        </Picker>
      </View>

      <Text style={styles.label}>
        Property Usage <Text style={{ color: '#e53935' }}>*</Text>
      </Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={propertyUsage} onValueChange={setPropertyUsage}>
          <Picker.Item label="Select Usage" value="" />
          <Picker.Item label="For Rentals / Apartments" value="rentals_apartments" />
          <Picker.Item label="Residence" value="residence" />
          <Picker.Item label="Shops" value="shops" />
        </Picker>
      </View>
      {!propertyUsage ? (
        <Text style={{ color: '#aaa', fontSize: 11, marginBottom: 4, marginTop: -2 }}>
          Required — helps buyers know what the land can be used for
        </Text>
      ) : null}

      <Text style={styles.label}>To Main Road</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={toMainRoad} onValueChange={setToMainRoad}>
          <Picker.Item label="Select Distance" value="" />
          <Picker.Item label="1 min walk" value="1_min" />
          <Picker.Item label="2 min walk" value="2_min" />
          <Picker.Item label="3 min walk" value="3_min" />
          <Picker.Item label="4 min walk" value="4_min" />
          <Picker.Item label="5 min walk" value="5_min" />
          <Picker.Item label="1k boda" value="1000_boda" />
          <Picker.Item label="2k boda" value="2000_boda" />
          <Picker.Item label="3k boda" value="3000_boda" />
          <Picker.Item label="4k boda" value="4000_boda" />
          <Picker.Item label="5k boda" value="5000_boda" />
        </Picker>
      </View>

      <Text style={styles.label}>Transport to Town</Text>
      <View style={styles.pickerWrapper}>
        <Picker mode="dropdown" selectedValue={transportToTown} onValueChange={setTransportToTown}>
          <Picker.Item label="Select Transport Cost" value="" />
          <Picker.Item label="1k taxi" value="1000" />
          <Picker.Item label="2k taxi" value="2000" />
          <Picker.Item label="3k taxi" value="3000" />
          <Picker.Item label="4k taxi" value="4000" />
          <Picker.Item label="5k taxi" value="5000" />
        </Picker>
      </View>

      <Text style={styles.label}>Owner Name</Text>
      <TextInput style={styles.input} value={ownerName} onChangeText={setOwnerName} placeholder="Enter owner name" />

      <Text style={styles.label}>Owner Number</Text>
      <TextInput style={styles.input} value={ownerNumber} onChangeText={setOwnerNumber} keyboardType="phone-pad" placeholder="Enter owner number" />

      <TouchableOpacity
        style={[styles.button, (submitting || uploading) && { opacity: 0.6 }]}
        onPress={submitLandProperty}
        disabled={submitting || uploading}
      >
        {submitting ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.buttonText}>Saving land...</Text>
          </View>
        ) : (
          <Text style={styles.buttonText}>Upload Land</Text>
        )}
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // =========================
  // MAIN RETURN
  // =========================
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 25}
    >
      <View style={styles.container}>
        <View style={styles.tabBar}>
          {(['RENT', 'LAND', 'PROPERTIES'] as TabType[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {activeTab === 'RENT'       && renderRentForm()}
        {activeTab === 'LAND'       && renderLandForm()}
        {activeTab === 'PROPERTIES' && renderPropertiesForm()}

        {/* VIDEO SOURCE MODAL */}
        <Modal visible={videoModal} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Select Video Source</Text>

              <TouchableOpacity
                style={styles.modalButton}
                onPress={() => { setVideoModal(false); setLibraryModal(true); }}
              >
                <Text style={styles.modalButtonText}>📁 Pick from App Folder</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalButton}
                onPress={async () => { setVideoModal(false); await pickVideoFromGallery(); }}
              >
                <Text style={styles.modalButtonText}>🖼 Pick from Gallery</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalButton}
                onPress={async () => {
                  setVideoModal(false);
                  const hasSpace = await checkCacheSize();
                  if (!hasSpace) return;
                  await AsyncStorage.setItem('pending_tab', activeTab);
                  setTimeout(() => router.push('/(tabs)/camera' as any), 150);
                }}
              >
                <Text style={styles.modalButtonText}>🎥 Record New Video</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.modalButton, { borderColor: '#eee' }]} onPress={() => setVideoModal(false)}>
                <Text style={[styles.modalButtonText, { color: '#999' }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* LIBRARY MODAL */}
        <Modal visible={libraryModal} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>App Video Library</Text>
              <ScrollView style={{ width: '100%', maxHeight: 360 }}>
                {savedVideos.length === 0 ? (
                  <Text style={{ color: '#999', textAlign: 'center', marginTop: 20 }}>No videos saved yet</Text>
                ) : (
                  <View style={styles.grid}>
                    {savedVideos.map((vid, i) => (
                      <View key={i} style={styles.thumbBox}>
                        <TouchableOpacity onPress={() => selectFromAppFolder(vid)}>
                          {vid.thumbnail ? (
                            <Image source={{ uri: vid.thumbnail }} style={styles.thumbnail} />
                          ) : (
                            <View style={styles.noThumb}>
                              <Text style={{ fontSize: 12, color: '#666' }}>No Preview</Text>
                            </View>
                          )}
                          <View style={{
                            position: 'absolute', bottom: 4, left: 4,
                            backgroundColor: vid.status === 'uploaded_to_cloudflare' ? 'rgba(76,175,80,0.85)' : 'rgba(255,152,0,0.85)',
                            borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2,
                          }}>
                            <Text style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>
                              {vid.status === 'uploaded_to_cloudflare' ? '✓ Uploaded' : 'Pending'}
                            </Text>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => deleteFromAppFolder(i)} style={styles.deleteBtn}>
                          <Text style={styles.deleteBtnText}>🗑</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
              </ScrollView>
              <TouchableOpacity style={[styles.modalButton, { marginTop: 12, borderColor: '#eee' }]} onPress={() => setLibraryModal(false)}>
                <Text style={[styles.modalButtonText, { color: '#999' }]}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* VIDEO PREVIEW MODAL */}
        {selectedVideo && (
          <VideoPreviewModal
            visible={previewModal}
            uri={selectedVideo.uri}
            onClose={closePreviewModal}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// =========================
// STYLES
// =========================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', backgroundColor: '#fff' },
  tab: { flex: 1, paddingVertical: 40, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#C4A484' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#999', letterSpacing: 0.5 },
  tabTextActive: { color: '#C4A484' },
  scrollContent: { flex: 1, padding: 15 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#222' },
  label: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 4, marginTop: 10 },
  sectionLabel: { fontSize: 13, color: '#666', marginBottom: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, marginBottom: 4, fontSize: 14, color: '#222' },
  pickerWrapper: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, marginBottom: 4, overflow: 'hidden' },
  uploadBox: { height: 120, borderWidth: 2, borderStyle: 'dashed', borderColor: '#C4A484', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 8, backgroundColor: '#fdf8f4' },
  button: { backgroundColor: '#C4A484', padding: 14, borderRadius: 6, marginTop: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  videoStatusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingHorizontal: 2 },
  uploadedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  greenDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4CAF50' },
  uploadedText: { color: '#4CAF50', fontSize: 12, fontWeight: '600' },
  pendingBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  orangeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF9800' },
  pendingText: { color: '#FF9800', fontSize: 12, fontWeight: '600' },
  changeText: { color: '#C4A484', fontSize: 13, fontWeight: '600' },
  uploadNowButton: { borderWidth: 1.5, borderColor: '#C4A484', borderRadius: 6, padding: 10, alignItems: 'center', marginBottom: 8 },
  uploadNowText: { color: '#C4A484', fontWeight: '600', fontSize: 14 },
  playOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8 },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  comingSoon: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  comingSoonText: { fontSize: 16, color: '#aaa', fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '85%', backgroundColor: '#fff', borderRadius: 14, padding: 20, alignItems: 'center' },
  modalTitle: { fontSize: 17, fontWeight: 'bold', marginBottom: 16, color: '#222' },
  modalButton: { width: '100%', padding: 13, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginBottom: 10, alignItems: 'center' },
  modalButtonText: { fontSize: 14, color: '#333', fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingHorizontal: 4 },
  thumbBox: { width: '48%', marginBottom: 10, borderRadius: 8, overflow: 'hidden', position: 'relative' },
  thumbnail: { width: '100%', height: 100, borderRadius: 8 },
  noThumb: { height: 100, justifyContent: 'center', alignItems: 'center', backgroundColor: '#eee', borderRadius: 8 },
  deleteBtn: { position: 'absolute', top: 5, right: 5, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 6, paddingVertical: 3 },
  deleteBtnText: { fontSize: 14, color: '#fff' },
});
