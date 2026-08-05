import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { API_URL } from '../../config/api';

export default function Profile() {
  const router = useRouter();

  const [broker, setBroker] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadBroker();
  }, []);

  const loadBroker = async () => {
    try {
      setLoading(true);

      // STEP 1: Get cached broker
      const cached = await AsyncStorage.getItem('broker');

      if (!cached) {
        router.replace('/');
        return;
      }

      const parsed = JSON.parse(cached);
      setBroker(parsed);

      if (!parsed?.id) {
        router.replace('/');
        return;
      }

      // STEP 2: Sync with backend
      const res = await fetch(`${API_URL}/brokers/${parsed.id}`);
      const data = await res.json();

      if (res.ok && data) {
        setBroker(data);
        await AsyncStorage.setItem('broker', JSON.stringify(data));
      }

    } catch (err) {
      console.log('Profile sync error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          try {
            setLoading(true);

            // 🔴 IMPORTANT: clear ALL auth traces
            await AsyncStorage.multiRemove(['broker', 'pending_email']);

            setBroker(null);

            // go back to login root
            router.replace('/');

          } catch (err) {
            console.log('Logout error:', err);
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadBroker();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#8B4513" />
      </View>
    );
  }

  if (!broker) {
    return (
      <View style={styles.center}>
        <Text>No broker found</Text>

        <TouchableOpacity onPress={() => router.replace('/')}>
          <Text style={{ marginTop: 10, color: '#8B4513' }}>
            Go to Login
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>

      <Text style={styles.title}>Broker Profile</Text>

      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={broker.full_name || ''} editable={false} />

      <Text style={styles.label}>ID</Text>
      <TextInput style={styles.input} value={String(broker.id || '')} editable={false} />

      <Text style={styles.label}>Email</Text>
      <TextInput style={styles.input} value={broker.email || ''} editable={false} />

      <Text style={styles.label}>Phone</Text>
      <TextInput style={styles.input} value={broker.phone || ''} editable={false} />

      {/* ACTIONS */}
      <TouchableOpacity style={styles.refreshBtn} onPress={handleRefresh}>
        <Text style={{ color: 'white' }}>Refresh</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={{ color: 'white' }}>Logout</Text>
      </TouchableOpacity>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    backgroundColor: '#fff'
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },

  title: {
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 20
  },

  label: {
    fontWeight: 'bold',
    marginTop: 10
  },

  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 10,
    borderRadius: 8,
    marginTop: 5
  },

  refreshBtn: {
    marginTop: 20,
    backgroundColor: '#444',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  },

  logoutBtn: {
    marginTop: 10,
    backgroundColor: 'red',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  }
});