import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from '../../config/api';
import { useRouter } from 'expo-router';

export default function HomeScreen() {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpVisible, setOtpVisible] = useState(false);
  const [loading, setLoading] = useState(false);
const router = useRouter();
// ✅ AUTO LOGIN CHECK (ADD THIS)
useEffect(() => {
  checkUser();
}, []);

const checkUser = async () => {
  const user = await AsyncStorage.getItem('broker');

  if (user) {
    router.replace('/(tabs)/home');
  }
};

  // ✅ SEND OTP
  const handleVerifyEmail = async () => {
    if (!email) return Alert.alert('Error', 'Enter email');

    try {
      setLoading(true);

      const res = await fetch(`${API_URL}/send-email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await res.json();

      if (res.ok) {
        Alert.alert('Success', 'OTP sent');
        setOtpVisible(true);
      } else {
        Alert.alert('Error', data.error || 'Failed');
      }

    } catch (err) {
      Alert.alert('Error', 'Network error');
    } finally {
      setLoading(false);
    }
  };

  // ✅ LOGIN
  const handleLogin = async () => {
    if (!otp) return Alert.alert('Error', 'Enter OTP');

    try {
      setLoading(true);

      const res = await fetch(`${API_URL}/verify-email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          otp,
          purpose: 'login'
        })
      });

      const data = await res.json();

      if (res.ok) {
        await AsyncStorage.setItem('broker', JSON.stringify(data.broker));
router.replace('/(tabs)/home');
      } else {
        Alert.alert('Error', data.error || 'OTP failed');
      }

    } catch (err) {
      Alert.alert('Error', 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  // ✅ CREATE ACCOUNT NAVIGATION
  const goToCreateAccount = () => {
    Alert.alert('Info', 'Navigate to create account screen');
    // later we will use:
    // router.push('/create-account')
  };

  return (
    <View style={styles.container}>

      {/* LOGIN BOX */}
      <View style={styles.box}>
        <Text style={styles.title}>Login</Text>

        <TextInput
          placeholder="Enter email"
          value={email}
          onChangeText={setEmail}
          style={styles.input}
        />

        <TouchableOpacity style={styles.button} onPress={handleVerifyEmail}>
          <Text style={styles.buttonText}>
            {loading ? 'Loading...' : 'Verify Email'}
          </Text>
        </TouchableOpacity>

        {otpVisible && (
          <>
            <TextInput
              placeholder="Enter OTP"
              value={otp}
              onChangeText={setOtp}
              style={styles.input}
            />

            <TouchableOpacity style={styles.button} onPress={handleLogin}>
              <Text style={styles.buttonText}>Login</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* CREATE ACCOUNT BOX */}
      <View style={styles.box}>
        <Text style={styles.title}>Create Account</Text>

        <Text style={{ textAlign: 'center', marginBottom: 10 }}>
          Don’t have an account yet?
        </Text>

        <TouchableOpacity
  style={styles.button}
  onPress={() => {
    console.log('NAVIGATING');
    router.push('/create-account');
  }}
>
  <Text style={styles.buttonText}>Go to Create Account</Text>
</TouchableOpacity>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    backgroundColor: '#f5f5f5'
  },
  box: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    marginBottom: 15
  },
  title: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 15
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 10,
    borderRadius: 8,
    marginBottom: 10
  },
  button: {
    backgroundColor: '#8B4513',
    padding: 12,
    borderRadius: 8,
    marginTop: 10
  },
  buttonText: {
    color: '#fff',
    textAlign: 'center'
  }
});