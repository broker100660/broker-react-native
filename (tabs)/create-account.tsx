import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  useColorScheme,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from '../../config/api';
import { router } from 'expo-router';

export default function CreateAccount() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [verified, setVerified] = useState(false);
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSendOtp = async () => {
    if (loading) return;
    if (!fullName || !phone || !emailInput) return Alert.alert('Error', 'All fields required');
    if (phone.length < 10) return Alert.alert('Error', 'Invalid phone number');
    try {
      setLoading(true);
      setPendingEmail(emailInput);
      const res = await fetch(`${API_URL}/brokers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, phone, email: emailInput })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Broker creation failed');
      const otpRes = await fetch(`${API_URL}/send-email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput })
      });
      const otpData = await otpRes.json();
      if (!otpRes.ok) throw new Error(otpData.error || 'OTP send failed');
      setOtpSent(true);
      Alert.alert('Success', 'OTP sent to email');
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (loading) return;
    if (!otp) return Alert.alert('Error', 'Enter OTP');
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/verify-email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail, otp, purpose: 'register' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'OTP failed');
      setVerified(true);
      setShowGuidelines(true);
      Alert.alert('Success', 'Email verified');
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptGuidelines = async () => {
    if (loading) return;
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/accept-guidelines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      const finalBroker = {
        full_name: fullName,
        phone,
        email: pendingEmail,
        email_verified: true,
        accepted_guidelines: true
      };
      await AsyncStorage.setItem('broker', JSON.stringify(finalBroker));
      Alert.alert('Success', 'Account created');
      router.replace('/(tabs)');
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  // Dynamic colors based on dark/light mode
  const bg = dark ? '#121212' : '#fff';
  const text = dark ? '#fff' : '#000';
  const inputBg = dark ? '#1e1e1e' : '#fff';
  const inputBorder = dark ? '#444' : '#ccc';
  const placeholder = dark ? '#888' : '#aaa';
  const guidelinesBg = dark ? '#1e1e1e' : '#f9f9f9';
  const guidelinesBorder = dark ? '#333' : '#ddd';

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: bg }]}>

      <Text style={[styles.title, { color: text }]}>Create Account</Text>

      <TextInput
        placeholder="Full Name"
        placeholderTextColor={placeholder}
        value={fullName}
        onChangeText={setFullName}
        style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
      />

      <TextInput
        placeholder="Phone"
        placeholderTextColor={placeholder}
        value={phone}
        onChangeText={setPhone}
        style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
      />

      <TextInput
        placeholder="Email"
        placeholderTextColor={placeholder}
        value={emailInput}
        onChangeText={setEmailInput}
        style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
      />

      {!otpSent && (
        <TouchableOpacity style={styles.button} onPress={handleSendOtp} disabled={loading}>
          <Text style={styles.buttonText}>{loading ? 'Sending...' : 'Create Account & Send OTP'}</Text>
        </TouchableOpacity>
      )}

      {otpSent && !verified && (
        <>
          <TextInput
            placeholder="Enter OTP"
            placeholderTextColor={placeholder}
            value={otp}
            onChangeText={setOtp}
            style={[styles.input, { backgroundColor: inputBg, borderColor: inputBorder, color: text }]}
          />
          <TouchableOpacity style={styles.button} onPress={handleVerifyOtp} disabled={loading}>
            <Text style={styles.buttonText}>{loading ? 'Verifying...' : 'Verify OTP'}</Text>
          </TouchableOpacity>
        </>
      )}

      {showGuidelines && (
        <View style={[styles.guidelinesBox, { backgroundColor: guidelinesBg, borderColor: guidelinesBorder }]}>
          <Text style={[styles.guidelinesTitle, { color: text }]}>Guidelines</Text>
          {[
            'Each property should have a single video of max 2min and 30seconds.',
            'All relevant details must be captured (entrance, inside etc.).',
            'Move with camera steadily (entrance, inside etc.).',
            'Photos not allowed.',
            'Always cross check with landlord for house availability after 2 days.',
            'Respond to clients promptly.',
            'Misleading content leads to cancellation.',
            'Honest work earns verification badge.',
            'Broker fee is paid after client acceptance.',
          ].map((item, i) => (
            <Text key={i} style={[styles.guidelineItem, { color: text }]}>• {item}</Text>
          ))}
          <TouchableOpacity style={styles.button} onPress={handleAcceptGuidelines} disabled={loading}>
            <Text style={styles.buttonText}>{loading ? 'Please wait...' : 'Accept Guidelines'}</Text>
          </TouchableOpacity>
        </View>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 20,
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    textAlign: 'center',
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    padding: 10,
    marginBottom: 10,
    borderRadius: 8,
    fontSize: 15,
  },
  button: {
    backgroundColor: '#8B4513',
    padding: 12,
    borderRadius: 8,
    marginTop: 10,
  },
  buttonText: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: '600',
  },
  guidelinesBox: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    borderWidth: 1,
  },
  guidelinesTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  guidelineItem: {
    fontSize: 14,
    marginBottom: 6,
  },
});