import { Tabs } from 'expo-router';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

function MyTabBar({ navigation, state }: any) {
  const currentRoute = state.routes[state.index].name;

  // Hide tab bar on these screens
  if (['index', 'create-account', 'camera'].includes(currentRoute)) {
    return null;
  }

  const tabs = [
    { label: '🏠', text: 'Home',     route: 'home' },
    { label: '➕', text: 'Add',      route: 'add-property' },
    { label: '📋', text: 'Bookings', route: 'bookings' },
    { label: '👤', text: 'Profile',  route: 'profile' },
  ];

  return (
    <View style={styles.bar}>
      {tabs.map((tab) => {
        const isActive = state.routes[state.index].name === tab.route;
        return (
          <TouchableOpacity
            key={tab.route}
            style={styles.tab}
            onPress={() => navigation.navigate(tab.route)}
          >
            <Text style={styles.icon}>{tab.label}</Text>
            <Text style={[styles.label, isActive && styles.activeLabel]}>
              {tab.text}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function Layout() {
  return (
    <Tabs
      tabBar={(props) => <MyTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="home" />
      <Tabs.Screen name="add-property" />
      <Tabs.Screen name="bookings" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="camera" />
      <Tabs.Screen name="create-account" />
      <Tabs.Screen name="explore" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 10,
    paddingBottom: 45,
    borderTopWidth: 1,
    borderColor: '#eee',
    backgroundColor: '#fff',
  },
  tab: {
    alignItems: 'center',
    flex: 1,
  },
  icon: {
    fontSize: 22,
  },
  label: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  activeLabel: {
    color: '#000',
    fontWeight: 'bold',
  },
});
