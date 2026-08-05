import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_URL } from '../../config/api';
import messaging from '@react-native-firebase/messaging';
import * as Clipboard from 'expo-clipboard';

// =========================
type CategoryType = 'RENT' | 'LAND' | 'PROPERTIES';

// The real signal for which category a booking/visit belongs to is which
// foreign key is populated: property_for_sale_id → PROPERTIES,
// land_property_id → LAND, property_id (and neither of the above) → RENT.
// booking_type only tells us paid vs scheduled_visit, not the category —
// a scheduled visit for a for-sale or land property still has booking_type
// "scheduled_visit", so it can't be used to separate them.
const getItemCategory = (item: any): CategoryType => {
  if (item?.property_for_sale_id != null) return 'PROPERTIES';
  if (item?.land_property_id != null) return 'LAND';
  return 'RENT';
};

// =========================
// LOCATION HELPERS (shared by all card types)
// =========================
const formatCoords = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

const copyCoords = async (lat: number, lng: number) => {
  try {
    await Clipboard.setStringAsync(formatCoords(lat, lng));
    Alert.alert('📋 Copied', 'Coordinates copied to clipboard');
  } catch (e) {
    console.log('[CLIPBOARD] copy error:', e);
  }
};

const openInMaps = (lat: number, lng: number) => {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  Linking.openURL(url).catch(() => {
    Alert.alert('Could not open Maps', 'Make sure you have Google Maps or a browser installed.');
  });
};

// Coordinates row — long-press to copy. Renders nothing if the property has no GPS saved.
function LocationBlock({ latitude, longitude }: { latitude?: number | null; longitude?: number | null }) {
  if (latitude == null || longitude == null) return null;
  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.sectionLabel}>Location</Text>
      <TouchableOpacity onLongPress={() => copyCoords(latitude, longitude)} activeOpacity={0.6}>
        <Text style={styles.detail}>📍 {formatCoords(latitude, longitude)}</Text>
        <Text style={styles.copyHint}>Long-press to copy</Text>
      </TouchableOpacity>
    </>
  );
}

// "Get Directions" button — opens Google Maps with turn-by-turn directions to the property.
function DirectionsButton({
  latitude,
  longitude,
  style,
}: {
  latitude?: number | null;
  longitude?: number | null;
  style?: any;
}) {
  if (latitude == null || longitude == null) return null;
  return (
    <TouchableOpacity
      style={[styles.actionBtn, styles.directionsBtn, style]}
      onPress={() => openInMaps(latitude, longitude)}
    >
      <Text style={styles.directionsBtnText}>🧭  Get Directions</Text>
    </TouchableOpacity>
  );
}

export default function BrokerBookings() {
  const insets = useSafeAreaInsets();
  const [broker, setBroker]         = useState<any>(null);
  const [bookings, setBookings]     = useState<any[]>([]);
  const [scheduled, setScheduled]   = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [playingId, setPlayingId]   = useState<string | null>(null);
  const [activeTab, setActiveTab]   = useState<'active' | 'scheduled' | 'ended'>('active');

  // ── Category tab: RENT / LAND / PROPERTIES ──
  // All three are live now. LAND mirrors the PROPERTIES card layout
  // (Owner instead of Landlord, property_usage instead of bedroom_type)
  // since land listings share that shape, not the rental shape.
  const [activeCategory, setActiveCategory] = useState<CategoryType>('RENT');

  const intervalRef                 = useRef<any>(null);
  const brokerIdRef                 = useRef<string | null>(null);

  // Split bookings/visits by category FIRST, then split by status within
  // that category — this is what keeps for-sale and land items from
  // leaking into the RENT tab regardless of which category is active.
  const categoryBookings = bookings.filter(b => getItemCategory(b) === activeCategory);
  const categoryScheduled = scheduled.filter(v => getItemCategory(v) === activeCategory);

  const activeBookings = categoryBookings.filter(b => !b.booking_statuses?.some((s: any) => s.status === 'ended'));

  // Scheduled visits still in progress (pending or started) — the broker
  // still has something to do here (Start Meeting), or is waiting on the
  // client to end + pay.
  const activeScheduled = categoryScheduled.filter(v => v.status !== 'ended');

  // Scheduled visits the client has already ended + paid for. These move
  // into the Ended tab alongside ended paid bookings, since from the
  // broker's perspective there's nothing left to do on either.
  const endedVisits = categoryScheduled.filter(v => v.status === 'ended');

  // Ended paid bookings (unchanged logic) + ended visits, merged into one
  // list for the Ended tab.
  const endedPaidBookings = categoryBookings.filter(b => b.booking_statuses?.some((s: any) => s.status === 'ended'));
  const endedBookings = [...endedPaidBookings, ...endedVisits];

  // =========================
  // FETCH BOOKINGS (RENT, PROPERTIES, and LAND all share the same
  // endpoints — categorization happens client-side above via
  // property_for_sale_id / land_property_id)
  // =========================
  const fetchBookings = async (id?: string) => {
    const targetId = id || brokerIdRef.current;
    if (!targetId) {
      setLoading(false);
      return;
    }

    try {
      // 1. Fetch Paid Bookings
      const res = await fetch(`${API_URL}/api/bookings/started/${targetId}`);
      const data = await res.json();
      setBookings(Array.isArray(data) ? data : []);

      // 2. Fetch Scheduled Visits
      const visitRes = await fetch(`${API_URL}/api/visits/broker/${targetId}`);
      const visitData = await visitRes.json();

      if (Array.isArray(visitData)) {
        setScheduled(visitData);
      } else if (visitData && Array.isArray(visitData.visit_requests)) {
        setScheduled(visitData.visit_requests);
      } else {
        setScheduled([]);
      }

    } catch (err) {
      console.log('Fetch completed with empty arrays or network drop:', err);
      setBookings([]);
      setScheduled([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // =========================
  // LOAD BROKER + START POLLING
  // =========================
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('broker');
        if (!raw) { setLoading(false); return; }
        const parsed = JSON.parse(raw);
        const id = parsed?.id || parsed?.broker?.id || parsed?.user?.id || parsed?.data?.id;
        if (!id) { setLoading(false); return; }
        setBroker({ ...parsed, id });
        brokerIdRef.current = id;
        await fetchBookings(id);
        intervalRef.current = setInterval(() => fetchBookings(id), 30000);
      } catch {
        setLoading(false);
      }
    })();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  // =========================
  // FOREGROUND NOTIFICATIONS
  // =========================
  useEffect(() => {
    const unsubscribeForeground = messaging().onMessage(async (remoteMessage) => {
      const type = remoteMessage.data?.type;
      const body = remoteMessage.notification?.body || '';
      if (type === 'new_booking') {
        Alert.alert('🏠 New Booking!', body, [{ text: 'OK', onPress: () => fetchBookings() }]);
      }
      if (type === 'meeting_started') {
        Alert.alert('🚗 Client Has Arrived!', body, [{ text: 'OK', onPress: () => fetchBookings() }]);
      }
      if (type === 'review_submitted') {
        Alert.alert('⭐ Review Submitted!', body);
      }
      if (type === 'visit_paid') {
        Alert.alert('💰 Visit Paid & Ended', body, [{ text: 'OK', onPress: () => fetchBookings() }]);
      }
    });

    const unsubscribeBackground = messaging().onNotificationOpenedApp((remoteMessage) => {
      const type = remoteMessage.data?.type;
      if (type === 'new_booking' || type === 'meeting_started' || type === 'visit_paid') fetchBookings();
    });

    return () => { unsubscribeForeground(); unsubscribeBackground(); };
  }, [fetchBookings]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchBookings();
  }, [fetchBookings]);

  // =========================
  // END MEETING (PAID CARS)
  // =========================
  const endMeeting = (bookingStatusId: string, bookingId: string) => {
    Alert.alert('End Meeting', 'Are you sure you want to end this meeting?', [
      { text: 'Not yet', style: 'cancel' },
      {
        text: 'End Meeting',
        style: 'destructive',
        onPress: async () => {
          try {
            const res = await fetch(`${API_URL}/api/booking-statuses/end`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                booking_id: bookingStatusId,
                actor_type: 'broker',
                actor_id: brokerIdRef.current,
              }),
            });
            if (res.ok) {
              Alert.alert('✅ Meeting ended');
              fetchBookings();
            } else {
              Alert.alert('Failed to end meeting');
            }
          } catch {
            Alert.alert('Error', 'Could not connect to server.');
          }
        },
      },
    ]);
  };

  // =========================
  // HELPERS
  // =========================
  const getStreamId = (url: string) => {
    if (!url) return null;
    return url.split('/')[3] || null;
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-UG', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  // Title line: LAND has no bedroom_type — show property_usage instead.
  // RENT/PROPERTIES keep the original property_type · bedroom_type format.
  const titleLine = (property: any) =>
    activeCategory === 'LAND'
      ? `${property?.property_type || 'Land'} · ${property?.property_usage || 'N/A'}`
      : `${property?.property_type || 'Property'} · ${property?.bedroom_type || 'N/A'}`;

  // Owner/Landlord section label + values — LAND uses owner_name/owner_number,
  // RENT/PROPERTIES use landlord_name/landlord_number.
  const contactLabel = activeCategory === 'LAND' ? 'Owner' : 'Landlord';
  const contactName = (property: any) =>
    activeCategory === 'LAND' ? (property?.owner_name || '—') : (property?.landlord_name || '—');
  const contactNumber = (property: any) =>
    activeCategory === 'LAND' ? property?.owner_number : property?.landlord_number;
  const contactButtonLabel = activeCategory === 'LAND' ? '🏠  Call Owner' : '🏠  Call Landlord';

  // =========================
  // ORIGINAL PAID BOOKING CARD (UNTOUCHED LOGIC — labels now dynamic)
  // =========================
  const renderActiveItem = ({ item }: any) => {
    const property      = item.properties;
    const streamId      = getStreamId(property?.video_url);
    const thumbnail     = streamId
      ? `https://videodelivery.net/${streamId}/thumbnails/thumbnail.jpg?time=0`
      : null;
    const isPlaying     = playingId === item.id;
    const statuses      = item.booking_statuses || [];
    const startedStatus = statuses.find((s: any) => s.status === 'started');
    const isPending     = !startedStatus;

    return (
      <View style={styles.card}>
        {isPlaying && streamId ? (
          <WebView
            style={styles.video}
            source={{ uri: `https://iframe.videodelivery.net/${streamId}?autoplay=true` }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
          />
        ) : (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => streamId && setPlayingId(item.id)}
            style={styles.thumbnailContainer}
          >
            {thumbnail ? (
              <>
                <WebView style={styles.video} source={{ uri: thumbnail }} scrollEnabled={false} />
                <View style={styles.playOverlay}>
                  <View style={styles.playBtn}>
                    <Text style={styles.playIcon}>▶</Text>
                  </View>
                </View>
              </>
            ) : (
              <View style={styles.thumbnailPlaceholder}>
                <Text style={{ fontSize: 48 }}>🏠</Text>
              </View>
            )}
          </TouchableOpacity>
        )}

        <View style={styles.details}>
          <Text style={styles.propertyType}>{titleLine(property)}</Text>
          <Text style={styles.detail}>📍 {property?.village}</Text>
          <Text style={styles.detail}>💰 UGX {property?.price}</Text>
          <Text style={styles.detail}>🚌 {property?.transport_to_town}</Text>
          <Text style={styles.detail}>🛣  {property?.to_main_road}</Text>
          <LocationBlock latitude={property?.latitude} longitude={property?.longitude} />
          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>{contactLabel}</Text>
          <Text style={styles.detail}>👤 {contactName(property)}</Text>
          <Text style={styles.detail}>📞 {contactNumber(property) || '—'}</Text>
          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>Client</Text>
          <Text style={styles.detail}>👤 {item.name || '—'}</Text>
          <Text style={styles.detail}>📱 {item.phone}</Text>
          <Text style={styles.detail}>🕐 Booked: {formatDate(item.booked_at)}</Text>

          <View style={[styles.statusBadge, isPending ? styles.badgePending : styles.badgeStarted]}>
            <Text style={[styles.statusText, isPending ? styles.statusTextPending : styles.statusTextStarted]}>
              {isPending ? '⏳  Waiting for client to start visit' : '🟢  Visit in progress'}
            </Text>
          </View>
          {isPending && <Text style={styles.autoRefreshHint}>🔄 Screen refreshes automatically every 30s</Text>}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={[styles.actionBtn, styles.callBtn]} onPress={() => Linking.openURL(`tel:${item.phone}`)}>
            <Text style={styles.callBtnText}>📞  Call Client</Text>
          </TouchableOpacity>
          <DirectionsButton latitude={property?.latitude} longitude={property?.longitude} />
          {contactNumber(property) && (
            <TouchableOpacity style={[styles.actionBtn, styles.landlordBtn]} onPress={() => Linking.openURL(`tel:${contactNumber(property)}`)}>
              <Text style={styles.landlordBtnText}>{contactButtonLabel}</Text>
            </TouchableOpacity>
          )}
          {!isPending && (
            <TouchableOpacity style={[styles.actionBtn, styles.endBtn]} onPress={() => endMeeting(startedStatus?.id, item.id)}>
              <Text style={styles.endBtnText}>🔴  End Meeting</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  // =========================
  // SCHEDULED VISIT CARD (labels now dynamic)
  // Broker only ever sees "Start Meeting" here. Ending + paying is done
  // entirely by the client, so once status becomes 'ended' this card no
  // longer appears in the Scheduled tab at all — it's filtered out into
  // endedVisits above and rendered by renderEndedItem instead.
  // =========================
  const renderScheduledVisitItem = ({ item }: any) => {
    const property = item.properties;
    const isPending = item.status === 'pending' || !item.status;
    const isStarted = item.status === 'started' || item.status === 'ongoing';

    const handleStartMeeting = async (visitId: string) => {
      try {
        const payload = {
          visit_id: visitId,
          actor_type: 'broker',
          actor_id: brokerIdRef.current,
          action: 'start'
        };

        const response = await fetch(`${API_URL}/api/visits/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const responseData = await response.json();

        if (response.ok && responseData.success) {
          fetchBookings();
        } else {
          Alert.alert('Status Error', `Could not start meeting: ${responseData.error || 'Server error'}`);
        }
      } catch (err) {
        console.error("Network error:", err);
        Alert.alert('Connection Error', 'Failed to reach the server.');
      }
    };

    return (
      <View style={styles.card}>
        <View style={[styles.statusBadge, isPending ? styles.badgePending : styles.badgeStarted, { marginBottom: 14, marginHorizontal: 16 }]}>
          <Text style={[styles.statusText, isPending ? styles.statusTextPending : styles.statusTextStarted, { textAlign: 'center' }]}>
            {isPending ? '⏳  Pending Client Meeting' : '🟢  Inspection In Progress'}
          </Text>
        </View>

        <View style={styles.details}>
          <Text style={styles.propertyType}>{titleLine(property)}</Text>
          <Text style={styles.detail}>📍 Location: {property?.village || '—'}</Text>
          <Text style={styles.detail}>💰 UGX {property?.price || '—'}</Text>
          <Text style={styles.detail}>🚌 Transport: {property?.transport_to_town || '—'}</Text>
          <Text style={styles.detail}>🛣  Road Proximity: {property?.to_main_road || '—'}</Text>
          <LocationBlock latitude={property?.latitude} longitude={property?.longitude} />

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>{contactLabel}</Text>
          <Text style={styles.detail}>👤 {contactName(property)}</Text>
          <Text style={styles.detail}>📞 {contactNumber(property) || '—'}</Text>

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>Appointment Logistics</Text>
          <Text style={styles.detail}>📅 Date to Meet: {item.preferred_date || '—'}</Text>
          <Text style={styles.detail}>🌅 Meeting Window: <Text style={{ textTransform: 'capitalize' }}>{item.preferred_time_slot || '—'}</Text></Text>

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>Client Details</Text>
          <Text style={styles.detail}>👤 Name: {item.guest_name || item.name || '—'}</Text>
          <Text style={styles.detail}>📱 Contact: {item.client_number || item.phone || '—'}</Text>
        </View>

        {isPending && (
          <View style={{ marginHorizontal: 16, marginTop: 4, marginBottom: 12, padding: 10, backgroundColor: 'rgba(255,179,0,0.06)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,179,0,0.2)' }}>
            <Text style={{ color: '#FFB300', fontSize: 12, fontStyle: 'italic', textAlign: 'center', fontWeight: '500' }}>
              ⚠️ Proximity Notice: Only press start once you are physically standing face-to-face with the client.
            </Text>
          </View>
        )}

        <View style={[styles.actions, { flexDirection: 'column', gap: 8 }]}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.callBtn, { width: '100%', marginBottom: 0 }]}
            onPress={() => Linking.openURL(`tel:${item.client_number || item.phone}`)}
          >
            <Text style={styles.callBtnText}>📞  Call Client to Coordinate</Text>
          </TouchableOpacity>

          {contactNumber(property) && (
            <TouchableOpacity
              style={[styles.actionBtn, styles.landlordBtn, { width: '100%', marginBottom: 0 }]}
              onPress={() => Linking.openURL(`tel:${contactNumber(property)}`)}
            >
              <Text style={styles.landlordBtnText}>{contactButtonLabel}</Text>
            </TouchableOpacity>
          )}

          <DirectionsButton
            latitude={property?.latitude}
            longitude={property?.longitude}
            style={{ width: '100%', marginBottom: 0 }}
          />

          {isPending && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#D4AF37', width: '100%', borderRadius: 12, paddingVertical: 13, alignItems: 'center' }]}
              onPress={() => handleStartMeeting(item.id)}
            >
              <Text style={{ color: '#000', fontWeight: '900', fontSize: 13 }}>🚀 Start Meeting</Text>
            </TouchableOpacity>
          )}

          {isStarted && (
            <View style={{ width: '100%', padding: 12, backgroundColor: 'rgba(76,175,80,0.06)', borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(76,175,80,0.2)', paddingVertical: 13 }}>
              <Text style={{ color: '#4CAF50', fontWeight: '700', fontSize: 13, textAlign: 'center' }}>
                🚶‍♂️ Inspection ongoing... Client will end the meeting and pay to conclude the visit.
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  };

  // =========================
  // ENDED BOOKING/VISIT CARD (labels now dynamic)
  // Handles BOTH ended paid bookings and ended (paid) scheduled visits.
  // Visits are told apart from bookings by the presence of
  // `preferred_date`, a field only visit_requests rows have.
  // =========================
  const renderEndedItem = ({ item }: any) => {
    const property = item.properties;
    const isVisit = item.preferred_date !== undefined;

    const clientName = isVisit ? (item.guest_name || item.name || '—') : (item.name || '—');
    const clientPhone = isVisit ? (item.client_number || item.phone || '—') : item.phone;
    const timeLabel = isVisit ? (item.ended_at || item.booked_at) : item.booked_at;

    return (
      <View style={[styles.card, styles.cardEnded]}>
        <View style={styles.endedHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.endedTitle}>{titleLine(property)}</Text>
            <Text style={styles.endedSub}>📍 {property?.village}</Text>
            <Text style={styles.endedSub}>👤 {clientName} · 📱 {clientPhone}</Text>
            <Text style={styles.endedSub}>🕐 {formatDate(timeLabel)}</Text>
            {property?.latitude != null && property?.longitude != null && (
              <TouchableOpacity onLongPress={() => copyCoords(property.latitude, property.longitude)} activeOpacity={0.6}>
                <Text style={styles.endedSub}>🧭 {formatCoords(property.latitude, property.longitude)}</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.endedBadge}>
            <Text style={styles.endedBadgeText}>✓ ENDED</Text>
          </View>
        </View>
        <View style={styles.feeBox}>
          <Text style={styles.feeLabel}>{isVisit ? 'Visit Fee Earned' : 'Booking Fee Earned'}</Text>
          <Text style={styles.feeValue}>UGX {property?.broker_fee || '—'}</Text>
        </View>
        <DirectionsButton
          latitude={property?.latitude}
          longitude={property?.longitude}
          style={{ marginHorizontal: 14, marginTop: -6, marginBottom: 14 }}
        />
      </View>
    );
  };

  // Unique key across the merged bookings+visits Ended list, since a
  // booking and a visit could otherwise share the same numeric id.
  const endedKeyExtractor = (item: any) => {
    const isVisit = item.preferred_date !== undefined;
    return `${isVisit ? 'visit' : 'booking'}-${item.id}`;
  };

  // =========================
  // LOADING SPINNER
  // =========================
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#D4AF37" />
        <Text style={styles.loadingText}>Loading bookings…</Text>
      </View>
    );
  }

  // =========================
  // MAIN RETURN
  // =========================
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* ── Category tab bar: RENT / LAND / PROPERTIES ── */}
      <View style={styles.categoryTabBar}>
        {(['RENT', 'LAND', 'PROPERTIES'] as CategoryType[]).map((cat) => (
          <TouchableOpacity
            key={cat}
            style={[styles.categoryTab, activeCategory === cat && styles.categoryTabActive]}
            onPress={() => setActiveCategory(cat)}
          >
            <Text style={[styles.categoryTabText, activeCategory === cat && styles.categoryTabTextActive]}>
              {cat}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── RENT, LAND and PROPERTIES all share the same tab structure now.
           Data is pre-filtered above (categoryBookings/categoryScheduled)
           by property_for_sale_id / land_property_id vs plain property_id,
           so everything below this point already only sees the active
           category's items. LAND uses the same cards as PROPERTIES, just
           with Owner instead of Landlord and property_usage instead of
           bedroom_type in the title line (handled via titleLine/contact*
           helpers above). ── */}
      <View style={styles.topBar}>
        <Text style={styles.title}>My Bookings</Text>
        {categoryBookings.length > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{categoryBookings.length}</Text>
          </View>
        )}
      </View>

      {/* Status tab buttons */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'active' && styles.tabBtnActive]}
          onPress={() => setActiveTab('active')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'active' && styles.tabBtnTextActive]}>
            🏠 Active
          </Text>
          {activeBookings.length > 0 && (
            <View style={styles.tabCount}>
              <Text style={styles.tabCountText}>{activeBookings.length}</Text>
            </View>
          )}
          {activeTab === 'active' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'ended' && styles.tabBtnActive]}
          onPress={() => setActiveTab('ended')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'ended' && styles.tabBtnTextActive]}>
            ✓ Ended
          </Text>
          {endedBookings.length > 0 && (
            <View style={[styles.tabCount, { backgroundColor: '#4CAF50' }]}>
              <Text style={styles.tabCountText}>{endedBookings.length}</Text>
            </View>
          )}
          {activeTab === 'ended' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'scheduled' && styles.tabBtnActive]}
          onPress={() => setActiveTab('scheduled')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'scheduled' && styles.tabBtnTextActive]}>
            ⏳ Scheduled
          </Text>
          {activeScheduled.length > 0 && (
            <View style={[styles.tabCount, { backgroundColor: '#FFB300' }]}>
              <Text style={styles.tabCountText}>{activeScheduled.length}</Text>
            </View>
          )}
          {activeTab === 'scheduled' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>
      </View>

      {/* Active tab list feed */}
      {activeTab === 'active' && (
        activeBookings.length === 0 ? (
          <View style={styles.centered}>
            <Text style={{ fontSize: 48 }}>📋</Text>
            <Text style={styles.emptyTitle}>No active bookings</Text>
            <Text style={styles.emptyText}>Properties you have been booked for will appear here</Text>
          </View>
        ) : (
          <FlatList
            data={activeBookings}
            keyExtractor={(item) => item.id.toString()}
            renderItem={renderActiveItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}

      {/* Ended tab list feed — ended paid bookings + ended (paid) visits merged */}
      {activeTab === 'ended' && (
        endedBookings.length === 0 ? (
          <View style={styles.centered}>
            <Text style={{ fontSize: 48 }}>🏁</Text>
            <Text style={styles.emptyTitle}>No ended bookings</Text>
            <Text style={styles.emptyText}>Completed meetings will appear here</Text>
          </View>
        ) : (
          <FlatList
            data={endedBookings}
            keyExtractor={endedKeyExtractor}
            renderItem={renderEndedItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}

      {/* Scheduled tab list feed — only still-active visits (not yet ended+paid) */}
      {activeTab === 'scheduled' && (
        activeScheduled.length === 0 ? (
          <View style={styles.centered}>
            <Text style={{ fontSize: 48 }}>⏳</Text>
            <Text style={styles.emptyTitle}>No scheduled inspections</Text>
            <Text style={styles.emptyText}>Upcoming client visits will appear here</Text>
          </View>
        ) : (
          <FlatList
            data={activeScheduled}
            keyExtractor={(item) => item.id.toString()}
            renderItem={renderScheduledVisitItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}

    </View>
  );
}

// =========================
// STYLES
// =========================
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0a0a0a' },
  centered:    { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { color: '#D4AF37', fontSize: 13, letterSpacing: 0.5, marginTop: 8 },

  // ── Category tab bar (RENT / LAND / PROPERTIES) ──
  categoryTabBar: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  categoryTab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  categoryTabActive:     { borderBottomColor: '#D4AF37' },
  categoryTabText:       { fontSize: 13, fontWeight: '700', color: '#555', letterSpacing: 0.5 },
  categoryTabTextActive: { color: '#D4AF37' },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 14,
    backgroundColor: '#111', borderBottomWidth: 1, borderBottomColor: '#1e1e1e', gap: 10,
  },
  title:      { fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: 0.5, flex: 1 },
  countBadge: { backgroundColor: '#D4AF37', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  countText:  { color: '#000', fontSize: 12, fontWeight: '900' },

  tabRow: {
    flexDirection: 'row', backgroundColor: '#111',
    borderBottomWidth: 1, borderBottomColor: '#1e1e1e',
  },
  tabBtn: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    justifyContent: 'center', flexDirection: 'row', gap: 8, position: 'relative',
  },
  tabBtnActive:     {},
  tabBtnText:       { fontSize: 14, fontWeight: '700', color: '#555', letterSpacing: 0.5 },
  tabBtnTextActive: { color: '#D4AF37' },
  tabUnderline:     { position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, backgroundColor: '#D4AF37' },
  tabCount:         { backgroundColor: '#D4AF37', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, minWidth: 20, alignItems: 'center' },
  tabCountText:     { color: '#000', fontSize: 10, fontWeight: '900' },

  emptyTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 8 },
  emptyText:  { color: '#555', fontSize: 13, textAlign: 'center', paddingHorizontal: 40, marginTop: 4 },

  card: {
    backgroundColor: '#161616', borderRadius: 16, marginBottom: 18,
    overflow: 'hidden', borderWidth: 1, borderColor: '#222',
  },
  cardEnded: { backgroundColor: '#111', borderColor: 'rgba(255,255,255,0.08)' },

  endedHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 14 },
  endedTitle:     { color: '#aaa', fontSize: 14, fontWeight: '800', marginBottom: 4 },
  endedSub:       { color: '#555', fontSize: 12, marginBottom: 2 },
  endedBadge:     { backgroundColor: 'rgba(76,175,80,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(76,175,80,0.3)' },
  endedBadgeText: { color: '#4CAF50', fontSize: 11, fontWeight: '900' },

  feeBox: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: 14, marginBottom: 14, padding: 12,
    backgroundColor: 'rgba(212,175,55,0.08)', borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.2)',
  },
  feeLabel: { color: '#aaa', fontSize: 12, fontWeight: '600' },
  feeValue: { color: '#D4AF37', fontSize: 15, fontWeight: '900' },

  video:                { width: '100%', height: 220 },
  thumbnailContainer: { width: '100%', height: 220 },
  thumbnailPlaceholder: { width: '100%', height: 220, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },

  playOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)',
  },
  playBtn:  { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(212,175,55,0.9)', alignItems: 'center', justifyContent: 'center' },
  playIcon: { fontSize: 22, color: '#000', marginLeft: 4 },

  details:      { padding: 16 },
  propertyType: { fontSize: 17, fontWeight: '900', color: '#fff', marginBottom: 10 },
  detail:       { fontSize: 13, color: '#aaa', marginBottom: 5 },
  divider:      { height: 1, backgroundColor: '#222', marginVertical: 12 },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: '#D4AF37', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  copyHint:     { color: '#444', fontSize: 10, marginBottom: 2, fontStyle: 'italic' },

  statusBadge:       { marginTop: 12, borderRadius: 10, padding: 10, borderWidth: 1 },
  badgePending:      { backgroundColor: 'rgba(255,179,0,0.08)',   borderColor: 'rgba(255,179,0,0.3)'   },
  badgeStarted:      { backgroundColor: 'rgba(76,175,80,0.08)',   borderColor: 'rgba(76,175,80,0.3)'   },
  statusText:        { fontSize: 12, fontWeight: '700' },
  statusTextPending: { color: '#FFB300' },
  statusTextStarted: { color: '#4CAF50' },
  autoRefreshHint:   { color: '#444', fontSize: 11, marginTop: 8, textAlign: 'center' },

  actions:         { padding: 14, gap: 8, borderTopWidth: 1, borderTopColor: '#222' },
  actionBtn:       { paddingVertical: 13, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  callBtn:         { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333'    },
  callBtnText:     { color: '#fff',     fontWeight: '700', fontSize: 13 },
  landlordBtn:     { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#D4AF37' },
  landlordBtnText: { color: '#D4AF37',  fontWeight: '700', fontSize: 13 },
  directionsBtn:     { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#4285F4' },
  directionsBtnText: { color: '#4285F4', fontWeight: '700', fontSize: 13 },
  endBtn:          { backgroundColor: 'rgba(229,57,53,0.1)', borderWidth: 1.5, borderColor: '#E53935' },
  endBtnText:      { color: '#E53935', fontWeight: '900', fontSize: 13 },
});
