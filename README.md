# resilient-store-and-forward-iot-communication-system
LinkBridge AI is a resilient store-and-forward IoT system using ESP32, Wi-Fi, LoRa, LittleFS, microSD, AES-GCM security, and a React dashboard. It stores prioritized sensor data during outages, relays it through an intermediate node, and delivers it reliably to a secure gateway with ACK-based recovery.
probelm description:   Problem
In remote regions, disaster zones, agricultural fields, and industrial sites, Wi-Fi and other communication links can become unavailable or unstable. When this happens, IoT sensor nodes may lose important readings, delay emergency alerts, or waste power and storage through repeated blind transmission attempts.
Who it affects
Farmers and rural communities that need reliable soil, weather, and crop-monitoring data.
Disaster-response teams and emergency responders who depend on timely environmental and safety alerts.
Industrial operators who must preserve critical equipment and safety readings.Why it matters
A delayed flood-related alert, missed safety reading, or lost emergency signal can delay response and increase risk. Existing IoT systems often assume continuous connectivity and do not effectively preserve, prioritize, and deliver data after an outage
Remote monitoring systems that operate in areas with weak or intermittent connectivity.
key features: 1. Local store-and-forward during outages
2. Direct Wi-Fi with LoRa relay fallback
3. Priority handling for emergency alerts
4. Unique IDs, CRC, AES-GCM security, ACKs, and duplicate prevention
5. Intermediate relay storage and recovery
6. Storage-aware queue management
7. ML-based advisory network-quality and transmission-opportunity analysis
8. Real-time dashboard monitoring
key features: 1. Local store-and-forward during outages
2. Direct Wi-Fi with LoRa relay fallback
3. Priority handling for emergency alerts
4. Unique IDs, CRC, AES-GCM security, ACKs, and duplicate prevention
5. Intermediate relay storage and recovery
system architecture: Approach
We built a three-node ESP32-based resilient IoT system that detects connectivity gaps, stores sensor data locally, prioritizes emergency events, and delivers data reliably through Wi-Fi or a LoRa-to-Wi-Fi relay.

Development steps
1. Sensor data collection: Node 1 reads rain, soil-moisture, and DHT11 temperature/humidity values.
2. Bundle creation: Each reading is converted into a compact packet with a unique ID, timestamp, priority, retry count, TTL, and CRC.
3. Local store-and-forward: Unacknowledged packets are saved in LittleFS during outages.
4. Path selection: Node 1 first checks direct Wi-Fi to the gateway; if unavailable, it switches to LoRa and sends data to Node 2.
5. Relay store-and-forward: Node 2 receives LoRa packets, validates them, stores them temporarily, and forwards them to the gateway over Wi-Fi when available.
6. Reliable delivery: The gateway validates, decrypts, deduplicates, and stores accepted packets on little fs before returning the final ACK.
7. Network analytics: Node 2 collects Wi-Fi metrics for the Node 2-to-Node 3 link, which are processed by two Random Forest models.
6.Monitoring and testing: A React dashboard displays sensors, packets, routes, storage, security, and ML predictions. The system is tested using controlled outages, retries, duplicates, and recovery scenarios.
<img width="975" height="1442" alt="image" src="https://github.com/user-attachments/assets/1db68672-a72d-457d-be68-260d76449bcf" />
how it works : 1. Input: Node 1 collects rain, soil-moisture, and DHT11 readings; the emergency button creates a P0 alert.
2. Processing: Node 1 creates a secure, prioritized bundle and saves unacknowledged packets in LittleFS.
3. Communication: Node 1 sends directly over Wi-Fi when available; otherwise, it uses LoRa to send to Node 2.
4. Store-and-forward: Node 2 temporarily stores relayed packets and forwards them to the gateway when Wi-Fi returns.
5. Reliable output: Node 3 validates, decrypts, deduplicates, stores accepted packets on microSD, and returns ACK_DELIVERED.
6. Monitoring: The React dashboard displays sensor data, packet journey, storage, security, link status, and ML-based network insights.
7. hardware components: 3 ESP32, 2LORA modules, DHT11,HW103,Rain drop sensor,Micro sd module and micro sd card,LCD display

6. Storage-aware queue management
7. ML-based advisory network-quality and transmission-opportunity analysis
8. Real-time dashboard monitoring
