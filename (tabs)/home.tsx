import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  FlatList,
  Modal,
  Alert,
  TextInput,
  RefreshControl,
  ScrollView,
  useColorScheme,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { API_URL } from '../../config/api';
import { WebView } from 'react-native-webview';
import { Linking, Share } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const CACHE_KEY = 'cached_properties';
const CACHE_KEY_FOR_SALE = 'cached_properties_for_sale';
const CACHE_KEY_LAND = 'cached_land_properties';

// =========================
// LOCATION HELPERS
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

export default function Home() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';

  const bg          = dark ? '#121212' : '#f5f5f5';
  const text        = dark ? '#fff' : '#000';
  const subText     = dark ? '#aaa' : '#999';
  const cardBg      = dark ? '#1e1e1e' : '#fff';
  const borderColor = dark ? '#333' : '#eee';
  const inputBg     = dark ? '#1e1e1e' : '#fff';
  const inputBorder = dark ? '#444' : '#ccc';
  const careModalBg = dark ? '#1e1e1e' : '#fff';

  const [broker, setBroker]           = useState<any>(null);
  const [activeTab, setActiveTab]     = useState<'RENT' | 'LAND' | 'PROPERTIES'>('RENT');
  const [properties, setProperties]   = useState<any[]>([]);
  const [forSaleProperties, setForSaleProperties] = useState<any[]>([]);
  const [landProperties, setLandProperties] = useState<any[]>([]); // NEW
  const [rentFilter, setRentFilter]   = useState<'active' | 'stays'>('active');
  const [saleFilter, setSaleFilter] = useState<'active' | 'stays'>('active');
  const [landFilter, setLandFilter] = useState<'active' | 'stays'>('active'); // NEW

  // ── Price search — only shown in the Active section. Non-destructive:
  // if a match exists in the currently displayed grid, scroll to it; if
  // not, leave the grid exactly as it is and just let the broker know.
  //
  // PERSISTENCE FIX: priceSearch is no longer cleared after a successful
  // search — it stays exactly as typed until the broker edits it
  // themselves, so they can keep re-searching the same price (e.g. after
  // the list refreshes) without retyping it. highlightedId is no longer
  // auto-cleared on a timer — the green border on the matched card now
  // persists until the broker switches tabs (see the useEffect below),
  // instead of silently disappearing after 3 seconds.
  const [priceSearch, setPriceSearch] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const gridRef = useRef<FlatList>(null);

  // Leaving the current tab (RENT/LAND/PROPERTIES) counts as "leaving that
  // page" — clear the green highlight then, but NOT on every re-render,
  // refresh, or re-search within the same tab.
  useEffect(() => {
    setHighlightedId(null);
  }, [activeTab]);

  const activeForSale = forSaleProperties.filter(p => p.computed_status === 'active');
  const staysForSale  = forSaleProperties.filter(p => p.computed_status === 'stays');
  const displayedForSale = saleFilter === 'active' ? activeForSale : staysForSale;

  // NEW — land computed lists, same pattern as for-sale
  const activeLand = landProperties.filter(p => p.computed_status === 'active');
  const staysLand  = landProperties.filter(p => p.computed_status === 'stays');
  const displayedLand = landFilter === 'active' ? activeLand : staysLand;

  const fetchForSaleProperties = async (brokerId: string, cached: string | null) => {
    try {
      const res = await fetch(`${API_URL}/api/broker/v2/properties-for-sale?brokerId=${brokerId}`);
      const txt = await res.text();
      const fresh = JSON.parse(txt);
      const freshStr = JSON.stringify(fresh);
      if (freshStr !== cached) {
        setForSaleProperties(fresh || []);
        await AsyncStorage.setItem(CACHE_KEY_FOR_SALE, freshStr);
      }
    } catch (err) {
      console.log('FETCH FOR-SALE PROPERTIES ERROR:', err);
    }
  };

  // NEW — mirrors fetchForSaleProperties, hits the land broker feed
  const fetchLandProperties = async (brokerId: string, cached: string | null) => {
    try {
      const res = await fetch(`${API_URL}/api/broker/v2/land-properties?brokerId=${brokerId}`);
      const txt = await res.text();
      const fresh = JSON.parse(txt);
      const freshStr = JSON.stringify(fresh);
      if (freshStr !== cached) {
        setLandProperties(fresh || []);
        await AsyncStorage.setItem(CACHE_KEY_LAND, freshStr);
      }
    } catch (err) {
      console.log('FETCH LAND PROPERTIES ERROR:', err);
    }
  };

  const [loading, setLoading]         = useState(false);
  const [refreshing, setRefreshing]   = useState(false);
  const [editPriceValue, setEditPriceValue] = useState('');
  const [careVisible, setCareVisible] = useState(false);
  const [queryText, setQueryText]     = useState('');
  const [queryPhone, setQueryPhone]   = useState('');
  const [selected, setSelected]       = useState<any>(null);
  const [visible, setVisible]         = useState(false);

  const activeProperties = properties.filter(p => p.computed_status === 'active');
  const staysProperties  = properties.filter(p => p.computed_status === 'stays');
  const displayedProperties = rentFilter === 'active' ? activeProperties : staysProperties;

  // ================== FCM ==================
  const registerFCMToken = async (brokerId: string) => {
    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
      }
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;
      if (!enabled) return;
      const fcmToken = await messaging().getToken();
      if (!fcmToken) return;
      await fetch(`${API_URL}/api/notifications/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: brokerId, user_type: 'broker', fcm_token: fcmToken }),
      });
      console.log('[FCM] Broker token registered');
    } catch (err: any) {
      console.log('[FCM] Error:', err.message);
    }
  };

  // ================== INIT ==================
  useEffect(() => {
    const init = async () => {
      try {
        const raw = await AsyncStorage.getItem('broker');
        if (!raw) { router.replace('/'); return; }
        const parsed = JSON.parse(raw);
        const id = parsed?.id || parsed?.broker?.id || parsed?.user?.id;
        if (!id) { router.replace('/'); return; }
        setBroker({ ...parsed, id });

        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) setProperties(JSON.parse(cached));

        const cachedForSale = await AsyncStorage.getItem(CACHE_KEY_FOR_SALE);
        if (cachedForSale) setForSaleProperties(JSON.parse(cachedForSale));

        const cachedLand = await AsyncStorage.getItem(CACHE_KEY_LAND); // NEW
        if (cachedLand) setLandProperties(JSON.parse(cachedLand));      // NEW

        fetchProperties(id, cached);
        fetchForSaleProperties(id, cachedForSale);
        fetchLandProperties(id, cachedLand); // NEW

        await registerFCMToken(id);
      } catch (err) {
        console.log('INIT ERROR:', err);
        router.replace('/');
      }
    };
    init();
  }, []);

  // ================== NOTIFICATIONS ==================
  useEffect(() => {
    const unsubscribe = messaging().onMessage(async (remoteMessage) => {
      const type = remoteMessage.data?.type;
      const body = remoteMessage.notification?.body || '';
      if (type === 'new_booking')      Alert.alert('🏠 New Booking!', body);
      if (type === 'meeting_started')  Alert.alert('🚗 Client Has Arrived!', body);
      if (type === 'review_submitted') Alert.alert('⭐ Review Submitted!', body);
    });
    return () => unsubscribe();
  }, [broker]);

  // ================== FETCH ==================
  const fetchProperties = async (brokerId: string, cached: string | null) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/api/broker/v2/properties?brokerId=${brokerId}`);
      const txt = await res.text();
      const fresh = JSON.parse(txt);
      const freshStr = JSON.stringify(fresh);
      if (freshStr !== cached) {
        setProperties(fresh || []);
        await AsyncStorage.setItem(CACHE_KEY, freshStr);
      }
    } catch (err) {
      console.log('FETCH PROPERTIES ERROR:', err);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      fetchProperties(broker.id, null),
      fetchForSaleProperties(broker.id, null),
      fetchLandProperties(broker.id, null), // NEW
    ]);
    setRefreshing(false);
  };

  // ================== CUSTOMER CARE ==================
  const saveCustomerCareLog = async (
    network: string | null, action: string,
    query: string | null = null, phone: string | null = null
  ) => {
    try {
      await fetch(`${API_URL}/customer-care/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: broker?.id, userType: 'broker', network, action, query, phone })
      });
    } catch (err) { console.log('CARE LOG ERROR:', err); }
  };

  const handleCall = async (network: string) => {
    const number = network === 'AIRTEL' ? '+256705679012' : '+256784160679';
    await saveCustomerCareLog(network, 'call');
    Linking.openURL(`tel:${number}`);
    setCareVisible(false);
  };

  const handleEmail = async () => {
    await saveCustomerCareLog('email', 'email');
    Linking.openURL('mailto:openbrokka@gmail.com');
    setCareVisible(false);
  };

  const submitQuery = async () => {
    await saveCustomerCareLog(null, 'query', queryText, queryPhone);
    setQueryText(''); setQueryPhone('');
    setCareVisible(false);
    Alert.alert('Query submitted!');
  };

  // ================== PROPERTY ACTIONS ==================
  const updateEvent = async (event: string) => {
    try {
      let propertyType = 'rent';

      if (activeTab === 'LAND') {
        propertyType = 'land';
      } else if (activeTab === 'PROPERTIES') {
        propertyType = 'for_sale';
      }

      await fetch(`${API_URL}/api/properties/${selected.id}/event`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event,
          propertyType,
        }),
      });

      Alert.alert('Success');
      setVisible(false);

      if (activeTab === 'RENT') {
        fetchProperties(broker.id, null);
      } else if (activeTab === 'LAND') {
        fetchLandProperties(broker.id, null);
      } else {
        fetchForSaleProperties(broker.id, null);
      }

    } catch (err) {
      Alert.alert('Error updating status');
    }
  };

  const deleteProperty = async () => {
    try {
      let propertyType = 'rent';

      if (activeTab === 'LAND') {
        propertyType = 'land';
      } else if (activeTab === 'PROPERTIES') {
        propertyType = 'for_sale';
      }

      await fetch(`${API_URL}/api/properties/${selected.id}/event`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event: 'BROKER_DELETE',
          propertyType,
        }),
      });

      Alert.alert('Marked as Taken');
      setVisible(false);

      if (activeTab === 'RENT') {
        fetchProperties(broker.id, null);
      } else if (activeTab === 'LAND') {
        fetchLandProperties(broker.id, null);
      } else {
        fetchForSaleProperties(broker.id, null);
      }

    } catch (e) {
      Alert.alert('Error updating status');
    }
  };

  const editPrice = async () => {
    if (!editPriceValue) return;

    try {
      let propertyType = 'rent';

      if (activeTab === 'LAND') {
        propertyType = 'land';
      } else if (activeTab === 'PROPERTIES') {
        propertyType = 'for_sale';
      }

      await fetch(`${API_URL}/api/properties/${selected.id}/price`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          price: editPriceValue,
          propertyType,
        }),
      });

      Alert.alert('Price updated!');
      setVisible(false);
      setEditPriceValue('');

      if (activeTab === 'RENT') {
        fetchProperties(broker.id, null);
      } else if (activeTab === 'LAND') {
        fetchLandProperties(broker.id, null);
      } else {
        fetchForSaleProperties(broker.id, null);
      }

    } catch (e) {
      Alert.alert('Error updating price');
    }
  };

  const openProperty = (item: any) => {
    setSelected(item);
    setEditPriceValue(item.price?.toString() || '');
    setVisible(true);
  };

  // ================== SHARE ==================
  const shareProperty = async () => {
    if (!selected) return;
    try {
      const message =
        `🏠 ${selected.property_type || 'Property'} · ${selected.bedroom_type || ''}\n` +
        `💰 UGX ${selected.price}\n` +
        `📍 ${selected.village || ''}\n\n` +
        `Watch the video:\n${selected.video_url}`;

      await Share.share({ message, url: selected.video_url });
    } catch (e) {
      console.log('[SHARE] error:', e);
    }
  };

  const getStreamId = (url: string) => {
    if (!url) return null;
    const match = url.match(/([a-f0-9]{32})/i);
    return match ? match[1] : null;
  };

  // ================== SEARCH BY PRICE (Active section only) ==================
  // Looks for an exact price match within the currently displayed grid
  // (already scoped to the active tab + Active filter). If found, scroll
  // to it. If not found, leave the grid untouched and just notify the
  // broker instead of clearing/replacing anything.
  //
  // PERSISTENCE FIX: previously this cleared priceSearch back to '' and
  // auto-cleared highlightedId after 3 seconds — both removed. The typed
  // price now stays in the box (so the broker can search it again after
  // a refresh without retyping), and the green highlight now stays on
  // the matched card until the broker switches tabs (handled by the
  // useEffect on activeTab above), not on a timer.
  const handlePriceSearch = () => {
    const query = priceSearch.trim().replace(/,/g, '');
    if (!query) return;

    const numericQuery = Number(query);
    if (isNaN(numericQuery) || numericQuery <= 0) {
      Alert.alert('Invalid price', 'Enter a valid numeric price to search.');
      return;
    }

    const matchIndex = currentData.findIndex((item: any) => {
      const itemPrice = Number(String(item.price).replace(/,/g, ''));
      return itemPrice === numericQuery;
    });

    if (matchIndex === -1) {
      Alert.alert('No match', 'No active property found with that exact price.');
      return;
    }

    if (matchIndex >= currentData.length) {
      Alert.alert('Try again', 'The list just updated — please search again.');
      return;
    }

    const matchedItem = currentData[matchIndex];

    try {
      gridRef.current?.scrollToIndex({ index: matchIndex, animated: true, viewPosition: 0.3 });
    } catch (e) {
      console.log('[SEARCH] scrollToIndex error:', e);
    }

    // Highlight the exact matched card so there's zero ambiguity about
    // which one scrolled into view, even with several visible at once.
    // Stays until the broker switches tabs — see the useEffect above.
    setHighlightedId(matchedItem.id);
  };

  // ================== RENDER ITEM ==================
  const renderItem = ({ item }: any) => {
    const streamId  = getStreamId(item.video_url);
    const thumbnail = `https://videodelivery.net/${streamId}/thumbnails/thumbnail.jpg?time=0`;
    const isHighlighted = item.id === highlightedId;
    return (
      <TouchableOpacity
        style={[
          styles.card,
          { backgroundColor: cardBg },
          isHighlighted && { borderWidth: 3, borderColor: '#4CAF50' },
        ]}
        onPress={() => openProperty(item)}
      >
        <Image source={{ uri: thumbnail }} style={styles.thumbnail} />
        <Text style={[styles.price, { color: text }]} numberOfLines={1}>
          UGX {item.price}
        </Text>
      </TouchableOpacity>
    );
  };

  if (!broker) {
    return (
      <View style={[styles.centered, { backgroundColor: bg }]}>
        <Text style={{ color: text }}>Loading...</Text>
      </View>
    );
  }

  // ✅ Manual status bar height for Android — SafeAreaView was pushing tabs too high
  const statusBarHeight = Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : insets.top;

  // Helper to pick the right filter state/values for whichever tab is active.
  // RENT/PROPERTIES/LAND all use the same active/stays filter UI now.
  const currentFilter =
    activeTab === 'RENT' ? rentFilter :
    activeTab === 'PROPERTIES' ? saleFilter :
    landFilter;

  const setCurrentFilter =
    activeTab === 'RENT' ? setRentFilter :
    activeTab === 'PROPERTIES' ? setSaleFilter :
    setLandFilter;

  const currentActiveCount =
    activeTab === 'RENT' ? activeProperties.length :
    activeTab === 'PROPERTIES' ? activeForSale.length :
    activeLand.length;

  const currentStaysCount =
    activeTab === 'RENT' ? staysProperties.length :
    activeTab === 'PROPERTIES' ? staysForSale.length :
    staysLand.length;

  // Data actually rendered in the grid for the active tab
  const currentData =
    activeTab === 'RENT' ? displayedProperties :
    activeTab === 'PROPERTIES' ? displayedForSale :
    displayedLand; // ← LAND now gets its own list instead of falling back to `properties`

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>

      {/* ── TOP BAR ── */}
      <View style={[
        styles.topBarWrapper,
        { backgroundColor: dark ? '#1a1a1a' : '#fff', paddingTop: statusBarHeight }
      ]}>
        <View style={[styles.topBar, { borderBottomColor: borderColor }]}>
          {(['RENT', 'LAND', 'PROPERTIES'] as const).map((tab) => (
            <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)}>
              <Text style={[
                styles.tabText, { color: subText },
                activeTab === tab && { color: text, fontWeight: 'bold' }
              ]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── FILTER ROW (RENT + PROPERTIES + LAND) ── */}
        <View style={[styles.filterRow, { borderBottomColor: borderColor }]}>
          <TouchableOpacity
            style={[styles.filterBtn, currentFilter === 'active' && styles.filterBtnActive]}
            onPress={() => setCurrentFilter('active')}
          >
            <Text style={[styles.filterBtnText, currentFilter === 'active' && styles.filterBtnTextActive]}>
              🏠 Active
            </Text>
            {currentActiveCount > 0 && (
              <View style={styles.filterCount}>
                <Text style={styles.filterCountText}>{currentActiveCount}</Text>
              </View>
            )}
            {currentFilter === 'active' && <View style={styles.filterUnderline} />}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterBtn, currentFilter === 'stays' && styles.filterBtnActive]}
            onPress={() => setCurrentFilter('stays')}
          >
            <Text style={[styles.filterBtnText, currentFilter === 'stays' && styles.filterBtnTextActive]}>
              ⏳ Stays
            </Text>
            {currentStaysCount > 0 && (
              <View style={[styles.filterCount, { backgroundColor: '#E53935' }]}>
                <Text style={styles.filterCountText}>{currentStaysCount}</Text>
              </View>
            )}
            {currentFilter === 'stays' && <View style={styles.filterUnderline} />}
          </TouchableOpacity>
        </View>

        {/* ── PRICE SEARCH — Active section only. Scrolls to a match in
             the grid if the exact price exists; otherwise leaves the
             grid untouched. Value persists until the broker edits it. ── */}
        {currentFilter === 'active' && (
          <View style={[styles.searchRow, { borderBottomColor: borderColor }]}>
            <TextInput
              style={[styles.searchInput, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
              placeholder="Search exact price…"
              placeholderTextColor={dark ? '#888' : '#aaa'}
              value={priceSearch}
              onChangeText={setPriceSearch}
              keyboardType="numeric"
              onSubmitEditing={handlePriceSearch}
              returnKeyType="search"
            />
            <TouchableOpacity style={styles.searchBtn} onPress={handlePriceSearch}>
              <Text style={styles.searchBtnText}>🔍</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ── GRID ── */}
      <View style={{ flex: 1 }}>
        {loading && properties.length === 0 ? (
          <Text style={{ textAlign: 'center', marginTop: 30, color: subText }}>Loading...</Text>
        ) : currentData.length === 0 ? (
          <View style={styles.centered}>
            <Text style={{ fontSize: 40 }}>{currentFilter === 'active' ? '🏠' : '⏳'}</Text>
            <Text style={{ color: subText, marginTop: 10, fontSize: 14 }}>
              {currentFilter === 'active' ? 'No active properties' : 'No properties staying 3+ days'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={gridRef}
            data={currentData}
            keyExtractor={(i) => i.id.toString()}
            numColumns={3}
            renderItem={renderItem}
            initialNumToRender={9}
            windowSize={5}
            removeClippedSubviews
            onScrollToIndexFailed={(info) => {
              // Grid layout doesn't have a fixed getItemLayout, so a
              // scroll to a far-off index can fail on the first try —
              // retry once it's roughly in range.
              setTimeout(() => {
                gridRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.3 });
              }, 100);
            }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={['#C4A484']}
                tintColor="#C4A484"
              />
            }
          />
        )}
      </View>

      {/* ── FLOATING CARE BUTTON ── */}
      <TouchableOpacity style={styles.floatingBtn} onPress={() => setCareVisible(true)}>
        <Text style={styles.floatingBtnText}>🎧</Text>
      </TouchableOpacity>

      {/* ── PROPERTY DETAIL MODAL ── */}
      <Modal visible={visible} animationType="slide">
        <View style={{ flex: 1, backgroundColor: bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 44 }}>
          <TouchableOpacity
            onPress={() => setVisible(false)}
            style={[styles.closeBtn, { borderBottomColor: borderColor }]}
          >
            <Text style={[styles.closeBtnText, { color: text }]}>✖  Close</Text>
          </TouchableOpacity>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
            {selected && (
              <>
                <View style={styles.videoContainer}>
                  <WebView
                    style={{ flex: 1 }}
                    source={{
                      uri: `https://iframe.videodelivery.net/${getStreamId(selected.video_url)}?autoplay=true`
                    }}
                    allowsInlineMediaPlayback
                    mediaPlaybackRequiresUserAction={false}
                  />
                </View>

                <View style={styles.quickActionsRow}>
                  <TouchableOpacity style={[styles.quickActionBtn, styles.shareBtn]} onPress={shareProperty}>
                    <Text style={styles.shareBtnText}>📤  Share Video</Text>
                  </TouchableOpacity>
                  {selected.latitude != null && selected.longitude != null && (
                    <TouchableOpacity
                      style={[styles.quickActionBtn, styles.directionsBtn]}
                      onPress={() => openInMaps(selected.latitude, selected.longitude)}
                    >
                      <Text style={styles.directionsBtnText}>🗺️  Directions</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <Text style={[styles.modalTitle, { color: text }]}>
                  {activeTab === 'LAND'
                    ? `${selected.property_type} · ${selected.property_usage}` // Plot/Estate · usage — no bedroom_type on land
                    : `${selected.property_type} · ${selected.bedroom_type}`}
                </Text>
                <Text style={[styles.modalDetail, { color: text }]}>💰 Price: UGX {selected.price}</Text>
                <Text style={[styles.modalDetail, { color: text }]}>📍 Village: {selected.village}</Text>
                <Text style={[styles.modalDetail, { color: text }]}>
                  📊 Status:{' '}
                  <Text style={{
                    fontWeight: '800',
                    color: selected.computed_status === 'active' ? '#4CAF50' :
                           selected.computed_status === 'stays'  ? '#FF9800' : '#aaa'
                  }}>
                    {selected.computed_status}
                  </Text>
                </Text>

                {selected.latitude != null && selected.longitude != null && (
                  <TouchableOpacity
                    onLongPress={() => copyCoords(selected.latitude, selected.longitude)}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.modalDetail, { color: text }]}>
                      🧭 GPS: {formatCoords(selected.latitude, selected.longitude)}
                    </Text>
                    <Text style={[styles.copyHint, { color: subText }]}>Long-press to copy</Text>
                  </TouchableOpacity>
                )}

                <View style={styles.modalDivider} />

                {/* Land uses Owner name/number; RENT & PROPERTIES use Landlord name/number */}
                <Text style={[styles.modalSection, { color: '#C4A484' }]}>
                  {activeTab === 'LAND' ? 'Owner' : 'Landlord'}
                </Text>
                <Text style={[styles.modalDetail, { color: text }]}>
                  👤 {activeTab === 'LAND' ? (selected.owner_name || '—') : (selected.landlord_name || '—')}
                </Text>
                <Text style={[styles.modalDetail, { color: text }]}>
                  📞 {activeTab === 'LAND' ? (selected.owner_number || '—') : (selected.landlord_number || '—')}
                </Text>

                <View style={styles.modalDivider} />

                <Text style={[styles.modalSection, { color: '#C4A484' }]}>Edit Price</Text>
                <TextInput
                  value={editPriceValue}
                  onChangeText={setEditPriceValue}
                  placeholder="Enter new price"
                  placeholderTextColor={dark ? '#888' : '#aaa'}
                  keyboardType="numeric"
                  style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
                />

                <View style={styles.modalActions}>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#4CAF50' }]} onPress={() => updateEvent('AVAILABLE')}>
                    <Text style={styles.modalBtnText}>✅ Available</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#555' }]} onPress={deleteProperty}>
                    <Text style={styles.modalBtnText}>🔒 Taken</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#C4A484' }]} onPress={editPrice}>
                    <Text style={styles.modalBtnText}>✏️ Save Price</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ── CUSTOMER CARE MODAL ── */}
      <Modal visible={careVisible} animationType="slide" transparent>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View style={[styles.careSheet, { backgroundColor: careModalBg }]}>
            <Text style={[styles.careTitle, { color: text }]}>🎧 Customer Care</Text>

            <TouchableOpacity style={styles.careOption} onPress={() => handleCall('AIRTEL')}>
              <Text style={[styles.careOptionText, { color: '#E53935' }]}>📞 Call Airtel — +256 705 679 012</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.careOption} onPress={() => handleCall('MTN')}>
              <Text style={[styles.careOptionText, { color: '#FFB300' }]}>📞 Call MTN — +256 784 160 679</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.careOption} onPress={handleEmail}>
              <Text style={[styles.careOptionText, { color: '#1565C0' }]}>✉️ Email — openbrokka@gmail.com</Text>
            </TouchableOpacity>

            <View style={[styles.careDivider, { backgroundColor: borderColor }]} />

            <Text style={{ color: subText, fontSize: 12, marginBottom: 8 }}>OR LEAVE A MESSAGE</Text>
            <TextInput
              placeholder="Your query…"
              placeholderTextColor={dark ? '#888' : '#aaa'}
              value={queryText}
              onChangeText={setQueryText}
              multiline
              numberOfLines={3}
              style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
            />
            <TextInput
              placeholder="Your phone number"
              placeholderTextColor={dark ? '#888' : '#aaa'}
              value={queryPhone}
              onChangeText={setQueryPhone}
              keyboardType="phone-pad"
              style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.careBtn, { backgroundColor: '#C4A484', flex: 1 }]} onPress={submitQuery}>
                <Text style={styles.careBtnText}>📨 Submit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.careBtn, { backgroundColor: '#333', flex: 1 }]} onPress={() => setCareVisible(false)}>
                <Text style={styles.careBtnText}>✕ Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered:  { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // ✅ replaces SafeAreaView — gives us manual control over top padding
  topBarWrapper: {},

  topBar: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 14, borderBottomWidth: 1,
  },
  tabText: { fontSize: 14 },

  filterRow: {
    flexDirection: 'row', borderBottomWidth: 1,
  },
  filterBtn: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    justifyContent: 'center', flexDirection: 'row', gap: 6, position: 'relative',
  },
  filterBtnActive:     {},
  filterBtnText:       { fontSize: 13, fontWeight: '700', color: '#999' },
  filterBtnTextActive: { color: '#C4A484' },
  filterUnderline:     { position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, backgroundColor: '#C4A484' },
  filterCount:         { backgroundColor: '#C4A484', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, minWidth: 20, alignItems: 'center' },
  filterCountText:     { color: '#000', fontSize: 10, fontWeight: '900' },

  // ── Price search row (Active section only) ──
  searchRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  searchInput: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 13,
  },
  searchBtn: {
    backgroundColor: '#C4A484', borderRadius: 10,
    paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center',
  },
  searchBtnText: { fontSize: 16 },

  card:      { flex: 1, margin: 5, borderRadius: 10 },
  thumbnail: { width: '100%', height: 120, borderRadius: 10 },
  price:     { fontSize: 12, padding: 4 },

  floatingBtn: {
    position: 'absolute', bottom: 20, right: 20,
    backgroundColor: '#000', width: 54, height: 54,
    borderRadius: 27, justifyContent: 'center', alignItems: 'center',
    elevation: 5, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
  },
  floatingBtnText: { fontSize: 24 },

  closeBtn: {
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1,
  },
  closeBtnText: { fontSize: 16, fontWeight: '700' },

  videoContainer: {
    width: '100%', height: 220,
    borderRadius: 12, overflow: 'hidden',
    marginBottom: 16,
  },

  modalTitle:   { fontSize: 18, fontWeight: '900', marginBottom: 8 },
  modalDetail:  { fontSize: 14, marginBottom: 6 },
  modalSection: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 },
  modalDivider: { height: 1, backgroundColor: '#222', marginVertical: 14 },
  copyHint:     { fontSize: 10, marginBottom: 10, fontStyle: 'italic' },

  quickActionsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  quickActionBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  shareBtn:          { backgroundColor: '#25D366' },
  shareBtnText:      { color: '#fff', fontWeight: '800', fontSize: 13 },
  directionsBtn:     { backgroundColor: '#4285F4' },
  directionsBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  input: {
    borderWidth: 1, borderRadius: 10,
    padding: 12, fontSize: 14, marginBottom: 10,
  },

  modalActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  modalBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  modalBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },

  careSheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40,
  },
  careTitle:      { fontSize: 18, fontWeight: '900', marginBottom: 16 },
  careOption:     { paddingVertical: 12 },
  careOptionText: { fontSize: 14, fontWeight: '700' },
  careDivider:    { height: 1, marginVertical: 14 },
  careBtn:        { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  careBtnText:    { color: '#fff', fontWeight: '700', fontSize: 13 },
});