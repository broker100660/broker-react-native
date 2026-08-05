import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      console.log('[checkAuth] starting');
      try {
        const raw = await AsyncStorage.getItem('broker');
        console.log('[checkAuth] AsyncStorage returned:', raw);
        const broker = raw ? JSON.parse(raw) : null;
        const id = broker?.id || broker?.broker?.id || broker?.user?.id;

        const isLoginScreen = segments.length <= 1; // (tabs)/index has no extra segment
        const isLoggedIn = !!id;

        if (isLoggedIn && isLoginScreen) {
          router.replace('/(tabs)/home');
        } else if (!isLoggedIn && !isLoginScreen) {
          router.replace('/');
        }
        console.log('[checkAuth] done, setting checked=true');
      } catch (err) {
        console.log('[checkAuth] ERROR:', err);
      } finally {
        setChecked(true);
      }
    };

    checkAuth();
  }, []); // runs ONCE on app start only

  if (!checked) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
     <Stack>
  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
  <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
</Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}