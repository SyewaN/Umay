/**
 * HydroSense Monitor - Academic Dashboard Application
 * Main application controller with theme, panel, map, and chart management
 */

// BLE senkronizasyonu tamamen Supabase tabanlı çalışır.
const BLE_SYNC_BASE_URL = (
    window.BLE_SYNC_BASE_URL ||
    localStorage.getItem('ble-sync-base-url') ||
    'https://flnjitprqlxytbcaoptc.supabase.co'
).replace(/\/+$/, '');
const BLE_SYNC_API_KEY = window.BLE_SYNC_API_KEY || 'sb_publishable_5_seWugPhmNDYtGO24NLFQ_ndcG19aL';
const BLE_SYNC_DEFAULT_API_URL = `${BLE_SYNC_BASE_URL}/rest/v1/sensor_data`;
const BLE_SYNC_DEFAULT_READ_URL = `${BLE_SYNC_BASE_URL}/rest/v1/sensor_data?select=*&order=id.desc&limit=200`;
const BLE_SYNC_API_URL = window.BLE_SYNC_API_URL || BLE_SYNC_DEFAULT_API_URL;
const BLE_SYNC_READ_URL = window.BLE_SYNC_READ_URL || BLE_SYNC_DEFAULT_READ_URL;
const BLE_SYNC_READ_ENABLED = String(window.BLE_SYNC_READ_ENABLED ?? 'true') === 'true';
const DASHBOARD_ENDPOINT = window.HYDROSENSE_DASHBOARD_URL ||
    localStorage.getItem('hydrosense-dashboard-url') ||
    '';
const STORAGE_KEY = 'hydrosense-ble-segments';
const ESP_LOCATION_KEY = 'hydrosense-esp-location';
const ESP_SENSOR_ID = 'esp-t1';
const ESP_SENSOR_NAME = 'esp-t1';
const DEFAULT_ESP_LAT = 39.96409142381642;
const DEFAULT_ESP_LON = 32.61008881714258;
const BLE_DEVICE_NAME = 'TarlaSensor';
// ESP ile birebir eşleşen UUID'ler
const BLE_SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const BLE_CHARACTERISTIC_UUID = '87654321-4321-4321-4321-cba987654321';
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Eski localStorage override'lari yanlis endpoint'e tasiyabildigi icin temizle.
try {
    const legacyReadEnabled = localStorage.getItem('ble-sync-read-enabled');
    if (legacyReadEnabled !== null) {
        localStorage.removeItem('ble-sync-read-enabled');
    }
    const legacyKey = localStorage.getItem('ble-sync-api-key');
    if (legacyKey && legacyKey !== BLE_SYNC_API_KEY) {
        localStorage.removeItem('ble-sync-api-key');
    }
    const legacyWriteUrl = localStorage.getItem('ble-sync-api-url');
    if (legacyWriteUrl && legacyWriteUrl !== BLE_SYNC_DEFAULT_API_URL) {
        localStorage.removeItem('ble-sync-api-url');
    }
    const legacyReadUrl = localStorage.getItem('ble-sync-read-url');
    if (legacyReadUrl && legacyReadUrl !== BLE_SYNC_DEFAULT_READ_URL) {
        localStorage.removeItem('ble-sync-read-url');
    }
} catch (_) {}

window.BLE_SYNC_DEVICE_NAME = BLE_DEVICE_NAME;
window.BLE_SYNC_SERVICE_UUID = BLE_SERVICE_UUID;
window.BLE_SYNC_CHARACTERISTIC_UUID = BLE_CHARACTERISTIC_UUID;
window.BLE_SYNC_LOCAL_KEY = STORAGE_KEY;
window.BLE_SYNC_API_HEADERS = BLE_SYNC_API_KEY
    ? {
        apikey: BLE_SYNC_API_KEY,
        Authorization: `Bearer ${BLE_SYNC_API_KEY}`,
        Prefer: 'return=representation'
    }
    : {};

function sendToAPI(data) {
    const payload = data;
    const endpoints = [BLE_SYNC_API_URL];
    const authVariants = BLE_SYNC_API_KEY
        ? [
            {
                "Content-Type": "application/json",
                apikey: BLE_SYNC_API_KEY,
                Authorization: `Bearer ${BLE_SYNC_API_KEY}`,
                Prefer: 'return=representation'
            }
        ]
        : [{ "Content-Type": "application/json" }];

    console.log("POST atiliyor mu?", payload);

    const tryPost = async (endpoint, headers) => {
        const res = await fetch(endpoint, {
            method: "POST",
            headers,
            mode: "cors",
            body: JSON.stringify(payload)
        });
        const raw = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} @ ${endpoint} - ${raw || 'empty response'}`);
        }
        try {
            return raw ? JSON.parse(raw) : { ok: true };
        } catch (_) {
            return { ok: true, raw };
        }
    };

    return (async () => {
        const errors = [];
        for (const endpoint of endpoints) {
            for (const headers of authVariants) {
                try {
                    console.log("POST endpoint:", endpoint, "headers:", Object.keys(headers).join(","));
                    const response = await tryPost(endpoint, headers);
                    console.log("API OK:", response);
                    return response;
                } catch (err) {
                    errors.push(String(err?.message || err));
                }
            }
        }
        const finalError = new Error(`Tum endpoint denemeleri basarisiz: ${errors.join(" | ")}`);
        console.error("API ERROR:", finalError);
        throw finalError;
    })();
}

class App {
    constructor() {
        this.sensors = [];
        this.filteredSensors = [];
        this.activeRisks = ['low', 'medium', 'high'];
        this.selectedSensor = null;
        this.mapOpen = false;
        this.mode = 'academy';
        this.language = 'tr';
        this.translations = this.buildTranslations();
        this.latestReading = null;
        this.bleDevice = null;
        this.bleServer = null;
        this.bleCharacteristic = null;
        this.bleConnected = false;
        this.mockMode = false;
        this.serverHistory = [];
        this.weatherHistory = [];
        this.weatherNow = null;
        this.charts = {};
        this.statusLockUntil = 0;
        this.onCharacteristicChanged = this.onCharacteristicChanged.bind(this);
        this.init();
    }

    // Make top-left logo clickable to return to main dashboard
    setupHomeButton() {
        const logoSection = document.querySelector('.navbar-logo-section');
        if (!logoSection) return;
        logoSection.style.cursor = 'pointer';
        logoSection.addEventListener('click', () => {
            // close map if open and show dashboard
            const mapToggleBtn = document.getElementById('mapToggle');
            const mapSection = document.querySelector('.map-section');
            const dashSection = document.querySelector('.dashboard-section');
            const mapSettings = document.querySelector('.map-settings');

            if (this.mapOpen) {
                // simulate toggle close
                this.mapOpen = false;
                dashSection.style.display = 'block';
                mapSection.style.display = 'none';
                mapSettings.style.display = 'none';
                this.updateMapToggleLabel();
            }

            // scroll dashboard to top for clarity
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    async init() {
        console.log('🚀 Initializing HydroSense Monitor...');
        
        // Load saved theme preference
        this.loadThemePreference();
        this.loadModePreference();
        this.loadLanguagePreference();
        
        // Load data
        await dataLoader.loadFromGeoJSON('data/sensors.geojson');
        // Demo sensor listesini kapat: üretimde tek gerçek ESP sensörü kullanılacak.
        this.sensors = [];
        this.restoreEspSensorFromSavedLocation();
        this.ensureDefaultEspSensor();
        console.log(`✓ Loaded ${this.sensors.length} active sensors`);
        
        // Setup all controls
        this.setupThemeToggle();
        this.setupModeToggle();
        this.setupSidebarToggle();
        this.setupRiskFilters();
        this.setupSensorSelect();
        this.setupMapToggle();
        this.setupHomeButton();
        this.setupTimeFilters();
        this.setupModalControls();
        this.setupLanguageControls();
        this.setupDeviceControls();
        this.initBLESync();
        
        // Initialize charts
        this.initCharts();
        this.applyMode();
        this.applyLanguage();
        
        // Initial render
        this.render();

        // Dashboard canlı kalsın diye periyodik güncelleme.
        this.loadLatestFromLocal();
        this.refreshLatestFromApi();
        this.refreshHistoryFromApi();
        this.refreshWeatherFromApi();
        // Local queue -> AWS/PM2 ingest (hafif periyot)
        setInterval(() => {
            this.autoSyncWhenOnline();
        }, 60000);
        setInterval(() => {
            this.refreshWeatherFromApi();
        }, WEATHER_REFRESH_INTERVAL_MS);
        
        // Update timestamp
        this.updateTimestamp();
        setInterval(() => this.updateTimestamp(), 60000);
        
        // NOTE: Do NOT initialize the map renderer here. Map is heavy and should
        // only be created when the user opens the map (map default closed).
        // mapRenderer will be created on demand in setupMapToggle().
    }

    // ====== DEVICE DATA (PRIMARY: BLUETOOTH, FALLBACK: MOCK) ======
    /**
     * PRIMARY SOURCE: Bluetooth
     * Eğer cihaz bağlı değilse mock kullanılabilir.
     */
    async getSensorData() {
        const bluetoothData = await this.readBluetoothData();
        if (bluetoothData) return bluetoothData;
        this.mockMode = true;
        return this.getMockSensorData();
    }

    /**
     * Bluetooth bağlantısını başlatır.
     * TODO: ESP hazır olduğunda burada requestDevice, GATT server,
     * service ve characteristic okunacak.
     */
    async connectBluetoothDevice() {
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth desteklenmiyor');
        }
        this.bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: BLE_DEVICE_NAME }],
            optionalServices: [BLE_SERVICE_UUID]
        });
        this.bleServer = await this.bleDevice.gatt.connect();
        const service = await this.bleServer.getPrimaryService(BLE_SERVICE_UUID);
        this.bleCharacteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
        this.bleConnected = true;
        this.mockMode = false;
        this.bleDevice.addEventListener('gattserverdisconnected', () => {
            this.bleConnected = false;
            this.updateConnectionStatus('Cihaz bağlı değil');
        });
    }

    /**
     * Bluetooth notify dinlemeyi başlatır.
     * TODO: ESP hazır olduğunda karakteristik notify formatı burada netleşecek.
     */
    async startBluetoothNotifications() {
        if (!this.bleCharacteristic) throw new Error('BLE characteristic bulunamadı');
        await this.bleCharacteristic.startNotifications();
        this.bleCharacteristic.removeEventListener('characteristicvaluechanged', this.onCharacteristicChanged);
        this.bleCharacteristic.addEventListener('characteristicvaluechanged', this.onCharacteristicChanged);
    }

    /**
     * Bluetooth'tan bir kez veri okumayı dener.
     * Cihaz hazır değilse null döner ve mock fallback tetiklenir.
     */
    async readBluetoothData() {
        if (!this.bleCharacteristic) return null;
        const value = await this.bleCharacteristic.readValue();
        const text = new TextDecoder('utf-8').decode(value);
        return this.parseSensorPayload(text);
    }

    /**
     * BLE notify callback.
     */
    onCharacteristicChanged(event) {
        const value = event.target.value;
        const text = new TextDecoder('utf-8').decode(value);
        this.processIncomingSensorText(text);
    }

    /**
     * Mock data üretimi (geliştirme fallback).
     */
    getMockSensorData() {
        const tdsRaw = Math.round(500 + Math.random() * 1800);
        const tdsComp = Math.max(0, tdsRaw - Math.round(5 + Math.random() * 30));
        return {
            tds: tdsComp,
            tdsRaw,
            tdsComp,
            moisture: null,
            temp: Number((15 + Math.random() * 15).toFixed(1)),
            timestamp: new Date().toISOString()
        };
    }

    parseNumeric(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') {
            const normalized = value.trim().replace(',', '.');
            if (!normalized) return null;
            const parsed = Number(normalized);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    normalizeSensorReading(input) {
        if (!input || typeof input !== 'object') return null;
        const tdsRaw = this.parseNumeric(input.tds_raw ?? input.tdsRaw ?? input.tds ?? input.TDS ?? input.tdsValue ?? input.salinity ?? input.salt);
        const tdsComp = this.parseNumeric(input.tds_comp ?? input.tdsComp ?? input.tds_corrected ?? input.tdsCorrected ?? input.tds ?? input.TDS ?? input.tdsValue ?? input.salinity ?? input.salt);
        const temp = this.parseNumeric(input.temp ?? input.temperature ?? input.sicaklik);
        const moisture = this.parseNumeric(input.moisture ?? input.humidity ?? input.nem ?? input.soil);
        const time = this.parseNumeric(input.time ?? input.device_time);
        const fromTime = this.toIsoTimestampFromNumericTime(time);
        const timestamp = input.timestamp || input.syncedAt || fromTime || new Date().toISOString();
        const lat = this.parseNumeric(input.lat ?? input.latitude);
        const lon = this.parseNumeric(input.lon ?? input.lng ?? input.longitude);

        const safeTdsRaw = Number.isFinite(tdsRaw) ? tdsRaw : null;
        const safeTdsComp = Number.isFinite(tdsComp) ? tdsComp : null;
        const safeTemp = Number.isFinite(temp) ? temp : null;
        const safeMoisture = Number.isFinite(moisture) ? moisture : null;
        const safeLat = Number.isFinite(lat) ? lat : null;
        const safeLon = Number.isFinite(lon) ? lon : null;
        const tds = Number.isFinite(safeTdsComp) ? safeTdsComp : safeTdsRaw;

        if (tds === null && safeTemp === null) return null;

        return {
            tds,
            tdsRaw: safeTdsRaw,
            tdsComp: safeTdsComp,
            moisture: safeMoisture,
            temp: safeTemp,
            time: Number.isFinite(time) ? time : null,
            timestamp,
            sensorId: input.sensor_id || input.sensorId || ESP_SENSOR_ID,
            sensorName: input.sensor_name || input.sensorName || ESP_SENSOR_NAME,
            lat: safeLat,
            lon: safeLon
        };
    }

    toIsoTimestampFromNumericTime(value) {
        if (!Number.isFinite(value)) return null;
        let unixMs = null;
        if (value > 1e12) unixMs = value;
        else if (value > 1e9) unixMs = value * 1000;
        if (!unixMs) return null;
        const date = new Date(unixMs);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    /**
     * UTF-8 metnini JSON parse edip beklenen sensör alanlarına map eder.
     */
    parseSensorPayload(text) {
        const list = this.parseSensorPayloadList(text);
        return list[list.length - 1];
    }

    parseSensorPayloadList(text) {
        const parsed = this.parseJsonPayload(text);
        if (Array.isArray(parsed?.data)) {
            const readings = [];
            for (let i = parsed.data.length - 1; i >= 0; i -= 1) {
                const normalized = this.normalizeSensorReading(parsed.data[i]);
                if (normalized) readings.push(normalized);
            }
            if (readings.length) return readings.reverse();
            throw new Error('data[] içinde geçerli sensör kaydı yok');
        }
        const normalized = this.normalizeSensorReading(parsed);
        if (!normalized) {
            throw new Error('Geçerli sensör kaydı bulunamadı');
        }
        return [normalized];
    }

    parseJsonPayload(text) {
        const raw = String(text ?? '').trim();
        if (!raw) throw new Error('Boş payload');
        try {
            return JSON.parse(raw);
        } catch (_) {
            const firstBrace = raw.indexOf('{');
            const lastBrace = raw.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                const candidate = raw.slice(firstBrace, lastBrace + 1);
                return JSON.parse(candidate);
            }
            const firstBracket = raw.indexOf('[');
            const lastBracket = raw.lastIndexOf(']');
            if (firstBracket !== -1 && lastBracket > firstBracket) {
                const candidate = raw.slice(firstBracket, lastBracket + 1);
                return JSON.parse(candidate);
            }
            throw new Error('Payload içinde JSON bulunamadı');
        }
    }

    appendReadingToHistory(reading) {
        if (!reading || typeof reading !== 'object') return;
        const hasBleValue = Number.isFinite(reading.tdsRaw) || Number.isFinite(reading.tdsComp) || Number.isFinite(reading.temp);
        if (!hasBleValue) return;
        this.serverHistory.push(reading);
        if (this.serverHistory.length > 240) {
            this.serverHistory = this.serverHistory.slice(-240);
        }
    }

    /**
     * Gelen sensör metnini işler, kaydeder ve UI'a yansıtır.
     */
    processIncomingSensorText(text) {
        try {
            const readings = this.parseSensorPayloadList(text);
            readings.forEach((data) => {
                this.persistDataPoint(data);
                this.upsertSensorFromReading(data);
                this.appendReadingToHistory(data);
            });
            const latest = readings[readings.length - 1];
            this.latestReading = latest;
            this.updateLiveValues(latest);
            this.updateLastSyncValue(latest.timestamp);
            this.updateCharts();
            this.updateDataStatus();
            if (navigator.onLine) {
                Promise.allSettled(readings.map((row) => sendToAPI(this.toApiPayload(row))))
                    .then((results) => {
                        const hasFailure = results.some((r) => r.status === 'rejected');
                        if (hasFailure) this.updateDataStatus('API gönderimi kısmen başarısız, localde saklandı');
                    });
            }
        } catch (err) {
            this.updateDataStatus('JSON parse hatası');
            console.error('Sensor parse failed:', err);
        }
    }

    toApiPayload(data) {
        const sicaklikValue = Number.isFinite(data?.temp)
            ? data.temp
            : (Number.isFinite(data?.sicaklik) ? data.sicaklik : null);
        const saltRawValue = Number.isFinite(data?.tdsComp)
            ? data.tdsComp
            : (Number.isFinite(data?.tdsRaw)
                ? data.tdsRaw
                : (Number.isFinite(data?.salt) ? data.salt : null));
        const sensorId = data?.sensorId || data?.sensor_id || ESP_SENSOR_ID;
        return {
            salt: Number.isFinite(saltRawValue) ? saltRawValue : null,
            sicaklik: sicaklikValue,
            sensor_id: sensorId
        };
    }

    /**
     * Her ölçüm noktasını localStorage kuyruğuna yazar.
     */
    persistDataPoint(data) {
        const queue = this.getStoredQueue();
        queue.push({
            ...data,
            timestamp: data.timestamp || new Date().toISOString()
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    }

    /**
     * localStorage kuyruğunu döner.
     */
    getStoredQueue() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (err) {
            console.error('Storage parse failed:', err);
            return [];
        }
    }

    /**
     * Bluetooth'tan gelen birikmiş veriyi buluta iletir.
     */
    async sendStoredDataToServer() {
        const queue = this.getStoredQueue();
        console.log('SEND QUEUE:', queue);
        if (!queue.length) {
            this.updateDataStatus('Gönderilecek veri yok');
            return;
        }
        const remaining = [];
        let sentCount = 0;
        let lastError = null;
        let skippedCount = 0;

        // Backend tek ölçüm objesi beklediği için sırayla gönder.
        for (const row of queue) {
            const payload = this.toApiPayload(row);
            const hasAnyValue = Number.isFinite(payload.salt) || Number.isFinite(payload.sicaklik);
            if (!hasAnyValue) {
                // Boş/bozuk satırı tekrar denemeye sokma.
                skippedCount += 1;
                continue;
            }

            try {
                await sendToAPI(payload);
                sentCount += 1;
            } catch (err) {
                remaining.push(row);
                lastError = err;
            }
        }

        if (remaining.length) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }

        if (sentCount === 0 && remaining.length === 0) {
            this.updateDataStatus(`Geçerli veri bulunamadı (atlanan: ${skippedCount})`);
            return;
        }

        if (sentCount > 0 && remaining.length === 0) {
            this.updateDataStatus(`Veriler sunucuya gönderildi (${sentCount}, atlanan: ${skippedCount})`);
            return;
        }

        if (sentCount > 0 && remaining.length > 0) {
            this.updateDataStatus(`Kismi gonderim: ${sentCount} basarili, ${remaining.length} beklemede, ${skippedCount} atlandi`);
            return;
        }

        const lastErrorText = lastError && lastError.message ? lastError.message : this.getFetchErrorMessage(lastError);
        throw new Error(`Ingest fetch hatasi: ${lastErrorText}`);
    }

    /**
     * İnternet geldiğinde kuyruktaki veriyi otomatik yollar.
     */
    async autoSyncWhenOnline() {
        if (!navigator.onLine) return;
        try {
            await this.sendStoredDataToServer();
        } catch (err) {
            console.error('Auto sync failed:', err);
        }
    }

    /**
     * Sunucuda işlenmiş en güncel veriyi alıp ekrana yansıtır.
     */
    async refreshLatestFromApi() {
        if (!BLE_SYNC_READ_ENABLED || !navigator.onLine) return;
        try {
            const latest = await this.fetchLatestRecord();
            if (!latest) return;
            const normalized = this.normalizeSyncedReading(latest);
            if (!normalized) return;
            this.latestReading = normalized;
            this.upsertSensorFromReading(normalized);
            this.updateLiveValues(normalized);
            this.updateLastSyncValue(normalized.timestamp);
            this.updateDataStatus();
            this.render();
        } catch (err) {
            console.error('Latest API fetch failed:', err);
            this.updateDataStatus(`Latest fetch: ${this.getFetchErrorMessage(err)}`);
        }
    }

    async fetchLatestRecord() {
        const headers = {
            Accept: 'application/json',
            ...window.BLE_SYNC_API_HEADERS
        };
        const endpoint = `${BLE_SYNC_BASE_URL}/rest/v1/sensor_data?select=*&order=id.desc&limit=1`;
        const res = await fetch(endpoint, { cache: 'no-store', headers });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Latest fetch HTTP ${res.status} (${endpoint}) ${body || ''}`.trim());
        }
        const payload = await res.json();
        if (!Array.isArray(payload) || !payload.length) return null;
        return payload[0];
    }

    /**
     * Sunucudaki geçmiş veriyi çekip grafikleri dinamik günceller.
     */
    async refreshHistoryFromApi() {
        if (!BLE_SYNC_READ_ENABLED || !navigator.onLine) return;
        try {
            const history = await this.fetchDashboardHistory();
            if (!history.length) return;

            const normalizedRows = [];
            history.forEach((row) => {
                if (Array.isArray(row?.data)) {
                    row.data.forEach((inner) => {
                        const normalized = this.normalizeSyncedReading(inner);
                        if (normalized) normalizedRows.push(normalized);
                    });
                    return;
                }
                const normalized = this.normalizeSyncedReading(row);
                if (normalized) normalizedRows.push(normalized);
            });

            this.serverHistory = normalizedRows
                .filter((row) => Number.isFinite(row.tdsRaw) || Number.isFinite(row.tdsComp) || Number.isFinite(row.temp));

            if (!this.serverHistory.length) return;
            this.serverHistory.forEach((row) => this.upsertSensorFromReading(row, false));
            if (this.mapOpen && window.mapRenderer) {
                window.mapRenderer.renderSensors(this.sensors);
            }
            this.updateCharts();
            this.render();
            this.updateDataStatus();
        } catch (err) {
            console.error('History API fetch failed:', err);
        }
    }

    async fetchDashboardHistory() {
        const headers = {
            Accept: 'application/json',
            ...window.BLE_SYNC_API_HEADERS
        };
        const endpoints = [
            BLE_SYNC_READ_URL,
            `${BLE_SYNC_BASE_URL}/rest/v1/sensor_data?select=*&order=id.desc&limit=200`
        ];

        const normalizePayloadToArray = (payload) => {
            if (Array.isArray(payload)) return payload;
            if (!payload || typeof payload !== 'object') return [];

            const candidates = [
                payload.data,
                payload.rows,
                payload.items,
                payload.history,
                payload.records,
                payload.readings,
                payload.dashboard
            ];
            for (const candidate of candidates) {
                if (Array.isArray(candidate)) return candidate;
                if (candidate && Array.isArray(candidate.data)) return candidate.data;
            }

            if (payload.latest && typeof payload.latest === 'object') return [payload.latest];
            if (payload.soil !== undefined || payload.salinity !== undefined) return [payload];
            return [];
        };

        const parseResponse = async (res, endpoint) => {
            if (!res.ok) {
                throw new Error('Dashboard fetch HTTP ' + res.status + ' (' + endpoint + ')');
            }
            const text = await res.text();
            if (!text) return [];
            try {
                return JSON.parse(text);
            } catch (_err) {
                const preview = text.slice(0, 120).replace(/\s+/g, ' ');
                throw new Error('JSON parse failed (' + endpoint + '): ' + preview);
            }
        };

        let lastError = null;
        for (const endpoint of endpoints) {
            try {
                const res = await fetch(endpoint, { cache: 'no-store', headers });
                const payload = await parseResponse(res, endpoint);
                const rows = normalizePayloadToArray(payload);
                if (rows.length) {
                    console.log('API DATA source:', endpoint, 'rows:', rows.length);
                    return rows;
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (lastError) {
            console.warn('Dashboard read skipped:', lastError);
        }
        return [];
    }

    getFetchErrorMessage(err) {
        const msg = String(err?.message || err || '');
        if (!navigator.onLine) return 'internet yok';
        if (msg.toLowerCase().includes('failed to fetch')) return 'sunucuya ulasilamadi / CORS / SSL';
        return msg || 'bilinmeyen ag hatasi';
    }

    initBLESync() {
        if (!window.BLESync) {
            this.updateConnectionStatus("BLESync hazır değil");
            return;
        }
        try {
            window.BLESync.init({
                apiUrl: BLE_SYNC_API_URL,
                headers: { ...window.BLE_SYNC_API_HEADERS }
            });
        } catch (err) {
            console.error("BLESync init failed:", err);
        }
    }

    normalizeSyncedReading(data) {
        if (!data || typeof data !== "object") return null;
        if (Array.isArray(data.data)) {
            for (let i = data.data.length - 1; i >= 0; i -= 1) {
                const normalized = this.normalizeSensorReading(data.data[i]);
                if (normalized) return normalized;
            }
            return null;
        }
        return this.normalizeSensorReading(data);
    }

    inferRiskFromTds(tds) {
        if (!Number.isFinite(tds)) return 'low';
        if (tds < 1500) return 'low';
        if (tds < 3000) return 'medium';
        return 'high';
    }

    upsertSensorFromReading(reading, rerenderMap = true) {
        if (!reading || !Number.isFinite(reading.tds)) return;
        const sensorId = reading.sensorId || reading.sensor_id || ESP_SENSOR_ID;
        const sensorName = reading.sensorName || reading.sensor_name || ESP_SENSOR_NAME;
        const existingIndex = this.sensors.findIndex((s) => s.id === sensorId);
        const nowTs = reading.timestamp || new Date().toISOString();

        if (existingIndex === -1) {
            const seed = this.sensors[0] || null;
            this.sensors.push({
                id: sensorId,
                name: sensorName,
                lat: Number.isFinite(reading.lat) ? reading.lat : (seed?.lat ?? DEFAULT_ESP_LAT),
                lon: Number.isFinite(reading.lon) ? reading.lon : (seed?.lon ?? DEFAULT_ESP_LON),
                tds: reading.tds,
                temperature: Number.isFinite(reading.temp) ? reading.temp : 0,
                riskLevel: this.inferRiskFromTds(reading.tds),
                timestamp: nowTs,
                dataPoints: [{ timestamp: nowTs, tds: reading.tds }]
            });
        } else {
            const sensor = this.sensors[existingIndex];
            sensor.name = sensorName;
            if (Number.isFinite(reading.lat)) sensor.lat = reading.lat;
            if (Number.isFinite(reading.lon)) sensor.lon = reading.lon;
            sensor.tds = reading.tds;
            if (Number.isFinite(reading.temp)) sensor.temperature = reading.temp;
            sensor.riskLevel = this.inferRiskFromTds(reading.tds);
            sensor.timestamp = nowTs;
            sensor.dataPoints = Array.isArray(sensor.dataPoints) ? sensor.dataPoints : [];
            sensor.dataPoints.push({ timestamp: nowTs, tds: reading.tds });
            if (sensor.dataPoints.length > 120) {
                sensor.dataPoints = sensor.dataPoints.slice(-120);
            }
        }

        if (this.mapOpen && window.mapRenderer && rerenderMap) {
            window.mapRenderer.renderSensors(this.sensors);
        }
    }

    getLatestBLELocalReading() {
        if (!window.BLESync || typeof window.BLESync.getLocal !== "function") return null;
        const localRows = window.BLESync.getLocal();
        if (!Array.isArray(localRows) || !localRows.length) return null;
        return localRows[localRows.length - 1];
    }

    updateLastSyncValue(timestamp) {
        const lastSyncEl = document.getElementById("lastSyncValue");
        if (!lastSyncEl) return;
        const date = new Date(timestamp || Date.now());
        if (Number.isNaN(date.getTime())) {
            lastSyncEl.textContent = "-";
            return;
        }
        lastSyncEl.textContent = date.toLocaleString("tr-TR");
    }

    setupDeviceControls() {
        const syncBtn = document.getElementById('readDeviceBtn');
        const sendBtn = document.getElementById('sendServerBtn');

        if (syncBtn) {
            syncBtn.addEventListener('click', async () => {
                syncBtn.disabled = true;
                const labelEl = syncBtn.querySelector('.navbar-btn-label');
                const prevLabel = labelEl ? labelEl.textContent : '';
                if (labelEl) labelEl.textContent = 'Bağlanıyor...';

                this.updateConnectionStatus('BLE bağlantısı başlatılıyor');
                this.updateDataStatus('Bağlanıyor...');

                try {
                    if (window.BLESync && typeof window.BLESync.sync === 'function') {
                        const syncResult = await window.BLESync.sync((message) => {
                            this.updateDataStatus(message || 'Veri okunuyor...');
                        });
                        const result = (syncResult && typeof syncResult === 'object' && 'reading' in syncResult)
                            ? syncResult.reading
                            : syncResult;
                        let uploadError = (syncResult && typeof syncResult === 'object')
                            ? syncResult.uploadError
                            : null;

                        const normalized =
                            this.normalizeSyncedReading(result) ||
                            this.normalizeSyncedReading(this.getLatestBLELocalReading());

                        if (normalized) {
                            this.latestReading = normalized;
                            this.upsertSensorFromReading(normalized);
                            this.appendReadingToHistory(normalized);
                            this.updateLiveValues(normalized);
                            this.updateLastSyncValue(normalized.timestamp);
                            this.updateCharts();
                            this.render();
                        }

                        this.bleConnected = true;
                        this.updateConnectionStatus('Cihaz bağlı');
                        if (normalized) {
                            try {
                                await sendToAPI(this.toApiPayload(normalized));
                                await this.sendStoredDataToServer();
                                uploadError = null;
                            } catch (postErr) {
                                uploadError = postErr;
                                console.error('Sync POST failed:', postErr);
                            }
                        }
                        if (uploadError) {
                            const msg = String(uploadError?.message || uploadError || 'gonderim beklemede');
                            this.showErrorStatus(`BLE okundu, gonderim beklemede: ${msg}`);
                        } else {
                            this.updateDataStatus('✅ Gönderildi!');
                        }
                        this.refreshLatestFromApi();
                        this.refreshHistoryFromApi();
                        // Supabase yazimi anlik gecikirse UI'i tekrar guncelle.
                        setTimeout(() => this.refreshLatestFromApi(), 600);
                        setTimeout(() => this.refreshHistoryFromApi(), 1200);
                    } else {
                        await this.connectBluetoothDevice();
                        await this.startBluetoothNotifications();
                        this.bleConnected = true;
                        this.updateConnectionStatus('Cihaz bağlı');
                        this.updateDataStatus('Veri bekleniyor');
                    }
                } catch (err) {
                    // BLESync üzerinden okuma başarısızsa, doğrudan BLE fallback ile tekrar dene.
                    try {
                        this.updateDataStatus('Bağlantı yeniden deneniyor...');
                        await this.connectBluetoothDevice();
                        await this.startBluetoothNotifications();
                        this.bleConnected = true;
                        this.updateConnectionStatus('Cihaz bağlı');
                        this.updateDataStatus('Veri bekleniyor');
                    } catch (fallbackErr) {
                        this.bleConnected = false;
                        this.updateConnectionStatus('Cihaz bağlı değil');
                        const msg = fallbackErr && fallbackErr.message ? fallbackErr.message : (err && err.message ? err.message : 'Eşitleme hatası');
                        this.showErrorStatus(msg);
                        console.error('Sync failed:', err);
                        console.error('Direct BLE fallback failed:', fallbackErr);
                    }
                } finally {
                    syncBtn.disabled = false;
                    if (labelEl) labelEl.textContent = prevLabel || 'Verileri Eşitle';
                }
            });
        }
        if (sendBtn) {
            sendBtn.addEventListener('click', async () => {
                sendBtn.disabled = true;
                try {
                    await this.sendStoredDataToServer();
                } catch (err) {
                    const msg = err && err.message ? err.message : 'Sunucuya gönderim başarısız';
                    this.showErrorStatus(`Sunucuya gönderim başarısız: ${msg}`);
                    console.error('Manual upload failed:', err);
                } finally {
                    sendBtn.disabled = false;
                }
            });
        }

        window.addEventListener('online', () => {
            this.autoSyncWhenOnline();
        });
    }

    /**
     * Son local veriyi yükler ve ekrana basar.
     */
    loadLatestFromLocal() {
        const queue = this.getStoredQueue();
        if (!queue.length) {
            this.updateDataStatus('Veri bekleniyor');
            return;
        }
        this.latestReading = queue[queue.length - 1];
        this.updateLiveValues(this.latestReading);
        this.updateDataStatus();
    }

    updateConnectionStatus(text) {
        const el = document.getElementById('connectionStatus');
        if (el) el.textContent = text;
    }

    showErrorStatus(message, holdMs = 20000) {
        const text = String(message || 'Bilinmeyen hata');
        const normalized = text.startsWith('❌') ? text : `❌ ${text}`;
        this.statusLockUntil = Date.now() + holdMs;
        this.updateDataStatus(normalized, { force: true });
        try {
            if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
                alert(normalized);
            }
        } catch (_) {}
    }

    updateDataStatus(customMessage = '', options = {}) {
        const force = Boolean(options?.force);
        const statusEl = document.getElementById('dataStatus');
        if (!statusEl) return;
        const isLocked = Date.now() < this.statusLockUntil;
        if (!force && isLocked) {
            if (!customMessage) return;
            if (!String(customMessage).startsWith('❌')) return;
        }
        if (customMessage) {
            statusEl.textContent = customMessage;
            return;
        }
        if (!this.latestReading) {
            statusEl.textContent = this.bleConnected ? 'Veri bekleniyor' : 'Cihaz bağlı değil';
            return;
        }
        statusEl.textContent = `Son veri: ${new Date(this.latestReading.timestamp).toLocaleTimeString('tr-TR')}`;
    }

    updateLiveValues(data) {
        if (!data || typeof data !== 'object') return;
        const tdsRawEl = document.getElementById('liveTdsRaw');
        const tdsCompEl = document.getElementById('liveTdsComp');
        const tempEl = document.getElementById('liveTemp');
        const dataTdsRaw = this.parseNumeric(data.tdsRaw);
        const dataTdsComp = this.parseNumeric(data.tdsComp);
        const dataTds = this.parseNumeric(data.tds);
        const dataTemp = this.parseNumeric(data.temp);
        const liveTdsRaw = Number.isFinite(dataTdsRaw) ? dataTdsRaw : dataTds;
        const liveTdsComp = Number.isFinite(dataTdsComp) ? dataTdsComp : dataTds;
        if (tdsRawEl) tdsRawEl.textContent = Number.isFinite(liveTdsRaw) ? `${liveTdsRaw} ppm` : '-';
        if (tdsCompEl) tdsCompEl.textContent = Number.isFinite(liveTdsComp) ? `${liveTdsComp} ppm` : '-';
        if (tempEl) tempEl.textContent = Number.isFinite(dataTemp) ? `${dataTemp}°C` : '-';

        // Minimal dashboard uyumluluğu (varsa bu id'lere de yaz)
        const soilEl = document.getElementById('soil');
        const salinityEl = document.getElementById('salinity');
        if (soilEl) soilEl.textContent = Number.isFinite(data.moisture) ? `${data.moisture}` : '-';
        if (salinityEl) salinityEl.textContent = Number.isFinite(data.tds) ? `${data.tds}` : '-';
    }

    getEspCoordinates() {
        const sensor = this.sensors.find((s) => s.id === ESP_SENSOR_ID);
        const lat = Number(sensor?.lat);
        const lon = Number(sensor?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            return { lat, lon };
        }
        try {
            const raw = localStorage.getItem(ESP_LOCATION_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                const savedLat = Number(parsed?.lat);
                const savedLon = Number(parsed?.lon);
                if (Number.isFinite(savedLat) && Number.isFinite(savedLon)) {
                    return { lat: savedLat, lon: savedLon };
                }
            }
        } catch (_) {}
        return { lat: DEFAULT_ESP_LAT, lon: DEFAULT_ESP_LON };
    }

    weatherDescriptionFromCode(code) {
        const map = {
            0: 'Açık',
            1: 'Az bulutlu',
            2: 'Parçalı bulutlu',
            3: 'Kapalı',
            45: 'Sisli',
            48: 'Kırağı sisli',
            51: 'Çisenti',
            53: 'Çisenti',
            55: 'Yoğun çisenti',
            56: 'Donan çisenti',
            57: 'Donan çisenti',
            61: 'Yağmurlu',
            63: 'Yağmurlu',
            65: 'Şiddetli yağmur',
            71: 'Kar',
            73: 'Kar',
            75: 'Yoğun kar',
            80: 'Sağanak',
            81: 'Sağanak',
            82: 'Şiddetli sağanak',
            95: 'Fırtına'
        };
        return map[code] || 'Bilinmiyor';
    }

    updateWeatherValue() {
        const weatherEl = document.getElementById('liveWeather');
        if (!weatherEl) return;
        if (!this.weatherNow || !Number.isFinite(this.weatherNow.temperature)) {
            weatherEl.textContent = '-';
            return;
        }
        const label = this.weatherNow.description || 'Hava';
        weatherEl.textContent = `${this.weatherNow.temperature}°C • ${label}`;
    }

    async refreshWeatherFromApi() {
        const coords = this.getEspCoordinates();
        const params = new URLSearchParams({
            latitude: String(coords.lat),
            longitude: String(coords.lon),
            current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
            current_weather: 'true',
            timezone: 'auto'
        });

        try {
            const res = await fetch(`${WEATHER_API_URL}?${params.toString()}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
            const payload = await res.json();
            const current = payload?.current || payload?.current_weather;
            if (!current) throw new Error('weather current verisi yok');
            const entry = {
                timestamp: current.time || new Date().toISOString(),
                temperature: this.parseNumeric(current.temperature_2m ?? current.temperature),
                humidity: this.parseNumeric(current.relative_humidity_2m),
                windSpeed: this.parseNumeric(current.wind_speed_10m ?? current.windspeed),
                code: this.parseNumeric(current.weather_code ?? current.weathercode),
                description: this.weatherDescriptionFromCode(Number(current.weather_code ?? current.weathercode))
            };
            this.weatherNow = entry;
            this.weatherHistory.push(entry);
            if (this.weatherHistory.length > 96) {
                this.weatherHistory = this.weatherHistory.slice(-96);
            }
            this.updateWeatherValue();
            this.updateCharts();
        } catch (err) {
            console.error('Weather API fetch failed:', err);
        }
    }

    // ====== THEME MANAGEMENT ======
    loadThemePreference() {
        const savedTheme = localStorage.getItem('hydrosense-theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        if (savedTheme === 'dark' || (savedTheme === null && prefersDark)) {
            document.body.classList.add('dark-theme');
        } else {
            document.body.classList.remove('dark-theme');
        }
    }

    setupThemeToggle() {
        const btn = document.getElementById('themeToggle');
        btn.addEventListener('click', () => {
            const isDark = document.body.classList.toggle('dark-theme');
            localStorage.setItem('hydrosense-theme', isDark ? 'dark' : 'light');
            this.updateThemeIcon();
        });
        this.updateThemeIcon();
    }

    updateThemeIcon() {
        const btn = document.getElementById('themeToggle');
        const isDark = document.body.classList.contains('dark-theme');
        btn.innerHTML = isDark ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
    }

    // ====== MODE MANAGEMENT ======
    loadModePreference() {
        const savedMode = localStorage.getItem('hydrosense-mode');
        if (savedMode === 'farmer' || savedMode === 'academy') {
            this.mode = savedMode;
        }
    }

    setupModeToggle() {
        document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (!mode || mode === this.mode) return;
                this.setMode(mode);
            });
        });
    }

    setMode(mode) {
        this.mode = mode;
        localStorage.setItem('hydrosense-mode', mode);
        this.applyMode();
        this.render();
    }

    applyMode() {
        document.body.dataset.mode = this.mode;
        this.updateDashboardTitle();

        document.querySelectorAll('.mode-toggle-btn').forEach(btn => {
            const isActive = btn.dataset.mode === this.mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        setTimeout(() => {
            Object.values(this.charts).forEach(chart => {
                if (chart && typeof chart.resize === 'function') {
                    chart.resize();
                }
            });
        }, 220);
    }

    updateDashboardTitle() {
        const title = document.getElementById('dashboardTitle');
        if (!title) return;
        const key = this.mode === 'farmer' ? 'dashboard.farmerTitle' : 'dashboard.academyTitle';
        title.textContent = this.t(key);
    }

    // ====== LANGUAGE MANAGEMENT ======
    buildTranslations() {
        return {
            tr: {
                'mode.farmer': 'Son Kullanıcı / Çiftçi',
                'mode.academy': 'Öğrenci / Akademi',
                'dashboard.farmerTitle': 'Çiftçi Paneli',
                'dashboard.academyTitle': 'Akademi Paneli',
                'time.1w': '1 Hafta',
                'time.2w': '2 Hafta',
                'meta.summary': 'Özet',
                'meta.top5': 'Top 5',
                'meta.8w': 'Son 8 hafta',
                'meta.current': 'Güncel',
                'meta.7d': 'Son 7 gün',
                'sidebar.title': 'Kontrol Merkezi',
                'sidebar.stats': 'İstatistikler',
                'sidebar.totalSensors': 'Toplam Sensör',
                'sidebar.avgTds': 'Ortalama TDS (ppm)',
                'sidebar.riskLevels': 'Risk Seviyeleri',
                'sidebar.low': 'Düşük',
                'sidebar.medium': 'Orta',
                'sidebar.high': 'Yüksek',
                'sidebar.sensorSelect': 'Sensör Seçimi',
                'sidebar.viewAll': 'Tümü Görüntüle',
                'sidebar.map': 'Harita',
                'sidebar.mapOpen': 'Aç',
                'sidebar.mapClose': 'Kapat',
                'sidebar.mapType': 'Harita Tipi',
                'sidebar.mapNormal': 'Normal Harita',
                'sidebar.mapSatellite': 'Uydu Görüntüsü',
                'sidebar.mapNasa': 'NASA Su Haritası',
                'sidebar.showSensors': 'Sensörleri Göster',
                'map.title': 'Harita Görünümü',
                'farmer.obrukTitle': 'Obruk Riski',
                'farmer.salinityTitle': 'Tuzlanma Durumu',
                'farmer.obrukDesc': 'Çiftçilere yönelik kısa açıklama.',
                'farmer.salinityDesc': 'Toprak/güncel tuzlanma durumu.',
                'farmer.toleranceTitle': '🌿 Bitkilerin Tuzluluk Toleransı',
                'farmer.cropsTitle': '🪴 Ekilen Ürünler: Tuzluluk & pH',
                'farmer.yieldTitle': '📉 Verim Düşüşü Eğilimi',
                'farmer.moistureTitle': '💧 Toprak Nem Göstergesi',
                'academy.tdsTitle': 'BLE Veri Serisi (TDS Raw/Comp + Sıcaklık)',
                'academy.riskTitle': 'Risk Dağılımı',
                'academy.compareTitle': 'Sensör Karşılaştırması',
                'academy.statsTitle': 'İstatistiksel Özet',
                'stats.max': 'Maksimum TDS',
                'stats.min': 'Minimum TDS',
                'stats.std': 'Std. Sapma',
                'stats.anomaly': 'Anomali Oranı',
                'settings.title': 'Ayarlar',
                'settings.language': 'Dil',
                'settings.links': 'Bağlantılar',
                'settings.github': 'GitHub Reposu',
                'settings.about': 'Hakkında',
                'settings.aboutText1': 'Projemiz farklı bölgelerdeki esp aygıtları ile aldıkları veriler arasında korelasyon tahmini yaparak obruk ve su tuzlanma riskini tahmin eder.',
                'settings.aboutText2': 'Proje kesinlik iddia etmez, deneyseldir.',
                'indicator.low': 'Düşük',
                'indicator.medium': 'Orta',
                'indicator.high': 'Yüksek',
                'indicator.obrukLow': 'Mevcut sensör verilerine göre obruk riski düşük.',
                'indicator.obrukMedium': 'Bölgede obruk riski artıyor. Kontrol önerilir.',
                'indicator.obrukHigh': 'Bölgedeki sensörler yüksek risk gösteriyor. İnceleme önerilir.',
                'indicator.salinityNormal': 'Tuzlanma seviyesi normal aralıkta.',
                'indicator.salinityMedium': 'Orta düzey tuzlanma tespit edildi; tarım etkilenebilir.',
                'indicator.salinityHigh': 'Yüksek tuzlanma; toprak ve sulama gözden geçirilmelidir.'
            },
            en: {
                'mode.farmer': 'End User / Farmer',
                'mode.academy': 'Student / Academy',
                'dashboard.farmerTitle': 'Farmer Panel',
                'dashboard.academyTitle': 'Academic Panel',
                'time.1w': '1 Week',
                'time.2w': '2 Weeks',
                'meta.summary': 'Summary',
                'meta.top5': 'Top 5',
                'meta.8w': 'Last 8 weeks',
                'meta.current': 'Current',
                'meta.7d': 'Last 7 days',
                'sidebar.title': 'Control Center',
                'sidebar.stats': 'Statistics',
                'sidebar.totalSensors': 'Total Sensors',
                'sidebar.avgTds': 'Average TDS (ppm)',
                'sidebar.riskLevels': 'Risk Levels',
                'sidebar.low': 'Low',
                'sidebar.medium': 'Medium',
                'sidebar.high': 'High',
                'sidebar.sensorSelect': 'Sensor Selection',
                'sidebar.viewAll': 'View All',
                'sidebar.map': 'Map',
                'sidebar.mapOpen': 'Open',
                'sidebar.mapClose': 'Close',
                'sidebar.mapType': 'Map Type',
                'sidebar.mapNormal': 'Standard Map',
                'sidebar.mapSatellite': 'Satellite Imagery',
                'sidebar.mapNasa': 'NASA Water Map',
                'sidebar.showSensors': 'Show Sensors',
                'map.title': 'Map View',
                'farmer.obrukTitle': '🕳️ Sinkhole Risk',
                'farmer.salinityTitle': '🧂 Salinity Status',
                'farmer.obrukDesc': 'Short, farmer-focused summary.',
                'farmer.salinityDesc': 'Current soil salinity condition.',
                'farmer.toleranceTitle': '🌿 Crop Salinity Tolerance',
                'farmer.cropsTitle': '🪴 Planted Crops: Salinity & pH',
                'farmer.yieldTitle': '📉 Yield Decline Trend',
                'farmer.moistureTitle': '💧 Soil Moisture Gauge',
                'academy.tdsTitle': 'BLE Series (TDS Raw/Comp + Temperature)',
                'academy.riskTitle': 'Risk Distribution',
                'academy.compareTitle': 'Sensor Comparison',
                'academy.statsTitle': 'Statistical Summary',
                'stats.max': 'Max TDS',
                'stats.min': 'Min TDS',
                'stats.std': 'Std. Deviation',
                'stats.anomaly': 'Anomaly Rate',
                'settings.title': 'Settings',
                'settings.language': 'Language',
                'settings.links': 'Links',
                'settings.github': 'GitHub Repository',
                'settings.about': 'About',
                'settings.aboutText1': 'Our project predicts sinkhole and water salinity risk by estimating correlations across ESP sensor data from different regions.',
                'settings.aboutText2': 'The project is experimental and does not claim certainty.',
                'indicator.low': 'Low',
                'indicator.medium': 'Medium',
                'indicator.high': 'High',
                'indicator.obrukLow': 'Sensor readings suggest a low sinkhole risk.',
                'indicator.obrukMedium': 'Sinkhole risk is rising. A check is recommended.',
                'indicator.obrukHigh': 'Sensors indicate high risk. Investigation is recommended.',
                'indicator.salinityNormal': 'Salinity is within the normal range.',
                'indicator.salinityMedium': 'Moderate salinity detected; crops may be affected.',
                'indicator.salinityHigh': 'High salinity; review soil and irrigation.'
            }
        };
    }

    loadLanguagePreference() {
        const savedLang = localStorage.getItem('hydrosense-lang');
        if (savedLang === 'en' || savedLang === 'tr') {
            this.language = savedLang;
        }
    }

    setupLanguageControls() {
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const lang = btn.dataset.lang;
                if (!lang || lang === this.language) return;
                this.setLanguage(lang);
            });
        });
        this.updateLanguageButtons();
    }

    setLanguage(lang) {
        this.language = lang;
        localStorage.setItem('hydrosense-lang', lang);
        this.applyLanguage();
        this.updateDashboardTitle();
        this.updateMapToggleLabel();
        this.updateIndicators();
    }

    t(key) {
        return this.translations[this.language]?.[key] || key;
    }

    applyLanguage() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            el.textContent = this.t(key);
        });
        this.updateLanguageButtons();
    }

    updateLanguageButtons() {
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.lang === this.language);
        });
    }

    // ====== SIDEBAR MANAGEMENT ======
    setupSidebarToggle() {
        const toggleBtn = document.getElementById('sidebarToggle');
        const sidebar = document.querySelector('.sidebar-panel');
        const overlay = document.getElementById('sidebarOverlay');
        const mobileBtn = document.getElementById('mobileSidebarBtn');
        const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

        const applySidebarState = (collapsed, persist = true) => {
            if (collapsed) {
                sidebar.classList.add('collapsed');
                toggleBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
                if (persist) localStorage.setItem('hydrosense-sidebar-collapsed', 'true');
                document.body.classList.remove('sidebar-open');
            } else {
                sidebar.classList.remove('collapsed');
                toggleBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
                if (persist) localStorage.removeItem('hydrosense-sidebar-collapsed');
                if (isMobile()) document.body.classList.add('sidebar-open');
            }
        };
        
        // Başlangıçta sidebar state'ini ayarla
        const savedState = localStorage.getItem('hydrosense-sidebar-collapsed');
        const isCollapsed = savedState === 'true';
        
        if (savedState === null && isMobile()) {
            applySidebarState(true, false);
        } else {
            applySidebarState(isCollapsed, false);
        }
        
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            applySidebarState(!sidebar.classList.contains('collapsed'));
        });

        if (mobileBtn) {
            mobileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                applySidebarState(!sidebar.classList.contains('collapsed'));
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                if (isMobile()) applySidebarState(true);
            });
        }

        // Swipe gestures for mobile sidebar
        let touchStartX = 0;
        let touchStartY = 0;
        let touchTracking = false;

        document.addEventListener('touchstart', (e) => {
            if (!isMobile() || e.touches.length !== 1) return;
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchTracking = true;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!touchTracking || !isMobile()) return;
            const touch = e.touches[0];
            const dx = touch.clientX - touchStartX;
            const dy = touch.clientY - touchStartY;
            if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;

            const isCollapsedNow = sidebar.classList.contains('collapsed');
            const nearLeftEdge = touchStartX < 24;

            if (dx > 40 && isCollapsedNow && nearLeftEdge) {
                applySidebarState(false);
                touchTracking = false;
            } else if (dx < -40 && !isCollapsedNow) {
                applySidebarState(true);
                touchTracking = false;
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            touchTracking = false;
        });

        window.addEventListener('resize', () => {
            if (!isMobile()) {
                document.body.classList.remove('sidebar-open');
            }
        });
    }

    // ====== RISK FILTERS ======
    setupRiskFilters() {
        document.querySelectorAll('input[data-risk]').forEach(checkbox => {
            checkbox.addEventListener('change', () => this.onRiskFilterChange());
        });
    }

    onRiskFilterChange() {
        this.activeRisks = [];
        document.querySelectorAll('input[data-risk]:checked').forEach(checkbox => {
            this.activeRisks.push(checkbox.dataset.risk);
        });
        this.render();
    }

    // ====== SENSOR SELECTION ======
    setupSensorSelect() {
        document.getElementById('sensorSelect').addEventListener('change', (e) => {
            this.selectedSensor = e.target.value || null;
            if (this.mapOpen && window.mapRenderer) {
                window.mapRenderer.highlightSensor(this.selectedSensor);
            }
        });
    }

    updateSensorSelect() {
        const select = document.getElementById('sensorSelect');
        const options = select.querySelectorAll('option');
        
        // Remove old options (keep first)
        for (let i = options.length - 1; i > 0; i--) {
            options[i].remove();
        }
        
        // Add filtered sensors
        this.filteredSensors.forEach(sensor => {
            const option = document.createElement('option');
            option.value = sensor.id;
            option.textContent = `${sensor.name} (${sensor.tds.toFixed(0)} ppm)`;
            select.appendChild(option);
        });
    }

    restoreEspSensorFromSavedLocation() {
        try {
            const raw = localStorage.getItem(ESP_LOCATION_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            const lat = Number(saved?.lat);
            const lon = Number(saved?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            this.applyEspLocation(lat, lon, 'saved');
        } catch (err) {
            console.error('ESP location restore failed:', err);
        }
    }

    ensureDefaultEspSensor() {
        const existing = this.sensors.find((s) => s.id === ESP_SENSOR_ID);
        if (existing) return;
        this.upsertSensorFromReading({
            sensorId: ESP_SENSOR_ID,
            sensorName: ESP_SENSOR_NAME,
            lat: DEFAULT_ESP_LAT,
            lon: DEFAULT_ESP_LON,
            tds: Number.isFinite(this.latestReading?.tds) ? this.latestReading.tds : 0,
            moisture: Number.isFinite(this.latestReading?.moisture) ? this.latestReading.moisture : 0,
            temp: Number.isFinite(this.latestReading?.temp) ? this.latestReading.temp : 0,
            timestamp: this.latestReading?.timestamp || new Date().toISOString()
        }, false);
    }

    safeSaveEspLocation(lat, lon, source = 'gps') {
        try {
            localStorage.setItem(ESP_LOCATION_KEY, JSON.stringify({ lat, lon, source, updatedAt: new Date().toISOString() }));
            return true;
        } catch (err) {
            console.error('ESP location local save failed:', err);
            return false;
        }
    }

    applyEspLocation(lat, lon, source = 'gps') {
        const persisted = this.safeSaveEspLocation(lat, lon, source);
        const existing = this.sensors.find((s) => s.id === ESP_SENSOR_ID);
        this.upsertSensorFromReading({
            sensorId: ESP_SENSOR_ID,
            sensorName: ESP_SENSOR_NAME,
            lat,
            lon,
            tds: Number.isFinite(this.latestReading?.tds) ? this.latestReading.tds : (Number(existing?.tds) || 0),
            moisture: Number.isFinite(this.latestReading?.moisture) ? this.latestReading.moisture : 0,
            temp: Number.isFinite(this.latestReading?.temp) ? this.latestReading.temp : (Number(existing?.temperature) || 0),
            timestamp: this.latestReading?.timestamp || new Date().toISOString()
        });
        this.selectedSensor = ESP_SENSOR_ID;
        this.render();
        this.focusMapOnEsp(lat, lon);
        this.refreshWeatherFromApi();
        if (!persisted) {
            this.updateDataStatus('Konum uygulandı (local kayıt başarısız)');
        }
    }

    focusMapOnEsp(lat, lon) {
        if (!this.mapOpen || !window.mapRenderer) return;
        window.mapRenderer.renderSensors(this.sensors);
        window.mapRenderer.highlightSensor(ESP_SENSOR_ID);
        if (window.mapRenderer.map) {
            setTimeout(() => {
                window.mapRenderer.map.invalidateSize();
                window.mapRenderer.map.flyTo([lat, lon], 16, { animate: true, duration: 0.8 });
            }, 60);
        }
    }

    requestAndSaveEspLocation() {
        if (!navigator.geolocation) {
            this.updateDataStatus('Konum servisleri desteklenmiyor');
            return;
        }
        if (!window.isSecureContext) {
            this.updateDataStatus('Konum için HTTPS gerekli');
            return;
        }
        this.updateDataStatus('Konum alınıyor...');
        let bestFix = null;
        const maybeApply = (coords) => {
            if (!coords) return;
            if (!bestFix || (Number.isFinite(coords.accuracy) && coords.accuracy < bestFix.accuracy)) {
                bestFix = {
                    lat: coords.latitude,
                    lon: coords.longitude,
                    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : 9999
                };
                this.applyEspLocation(bestFix.lat, bestFix.lon, 'gps');
                this.updateDataStatus(`ESP konumu kaydedildi (±${Math.round(bestFix.accuracy)}m)`);
            }
        };

        navigator.geolocation.getCurrentPosition(
            (position) => {
                maybeApply(position.coords);

                // Mobilde ilk fix kaba olabilir; 12 sn kadar daha iyi fix topla.
                let watchId = null;
                const stopTimer = setTimeout(() => {
                    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
                }, 12000);
                watchId = navigator.geolocation.watchPosition(
                    (watchPos) => {
                        maybeApply(watchPos.coords);
                        if (bestFix && bestFix.accuracy <= 25) {
                            clearTimeout(stopTimer);
                            navigator.geolocation.clearWatch(watchId);
                        }
                    },
                    () => {
                        clearTimeout(stopTimer);
                        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
                    },
                    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
                );
            },
            (err) => {
                this.updateDataStatus(`Konum alınamadı: ${err.message || 'izin hatası'}`);
            },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );
    }

    // ====== MAP TOGGLE ======
    setupMapToggle() {
        const mapToggleBtn = document.getElementById('mapToggle');
        const mapCloseBtn = document.getElementById('mapClose');
        const setEspLocationBtn = document.getElementById('setEspLocationBtn');
        const mapSection = document.querySelector('.map-section');
        const dashSection = document.querySelector('.dashboard-section');
        const mapSettings = document.querySelector('.map-settings');
        
        mapToggleBtn.addEventListener('click', () => {
            this.mapOpen = !this.mapOpen;
            
            if (this.mapOpen) {
                dashSection.style.display = 'none';
                mapSection.style.display = 'flex';
                mapSettings.style.display = 'block';
                this.updateMapToggleLabel();
                
                // Initialize map renderer on demand if not yet created
                if (!window.mapRenderer) {
                    window.mapRenderer = new MapRenderer('map', this.sensors);
                } else if (window.mapRenderer && window.mapRenderer.map) {
                    // ensure size is correct
                    setTimeout(() => window.mapRenderer.map.invalidateSize(), 50);
                }
            } else {
                dashSection.style.display = 'block';
                mapSection.style.display = 'none';
                mapSettings.style.display = 'none';
                this.updateMapToggleLabel();
            }
        });
        
        mapCloseBtn.addEventListener('click', () => {
            mapToggleBtn.click();
        });

        if (setEspLocationBtn) {
            setEspLocationBtn.addEventListener('click', () => {
                this.requestAndSaveEspLocation();
            });
        }
        
        // Map settings listeners
        document.getElementById('sensorMarkersToggle').addEventListener('change', (e) => {
            if (window.mapRenderer) {
                window.mapRenderer.toggleMarkers(e.target.checked);
            }
        });
        
        // Map type radio buttons
        document.querySelectorAll('input[name="mapType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (window.mapRenderer && e.target.checked) {
                    window.mapRenderer.setMapType(e.target.value);
                }
            });
        });

        this.updateMapToggleLabel();
    }

    updateMapToggleLabel() {
        const mapToggleBtn = document.getElementById('mapToggle');
        if (!mapToggleBtn) return;
        const labelKey = this.mapOpen ? 'sidebar.mapClose' : 'sidebar.mapOpen';
        const icon = this.mapOpen ? 'fa-times' : 'fa-map';
        mapToggleBtn.innerHTML = `<i class="fas ${icon}"></i> ${this.t(labelKey)}`;
    }

    // ====== TIME FILTERS ======
    setupTimeFilters() {
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.updateCharts();
            });
        });
    }

    // ====== MODAL CONTROLS ======
    setupModalControls() {
        const settingsBtn = document.getElementById('settingsBtn');
        const settingsModal = document.getElementById('settingsModal');
        const modalClose = document.getElementById('settingsClose');
        
        settingsBtn.addEventListener('click', () => {
            settingsModal.style.display = 'flex';
        });
        
        modalClose.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });
        
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModal.style.display = 'none';
            }
        });
    }

    // ====== CHART INITIALIZATION ====== 
    initCharts() {
        // Chart.js color scheme
        const chartColors = {
            low: '#A3BE8C',
            medium: '#EBCB8B',
            high: '#BF616A',
            accent: '#81A1C1',
            line: '#88C0D0',
            text: '#4D576A',
            grid: '#D7DDE8'
        };
        
        // Chart defaults
        Chart.defaults.color = chartColors.text;
        Chart.defaults.borderColor = chartColors.grid;
        
        // Chart 1: BLE Time Series (tds_raw / tds_comp / temp)
        const tdsCanvas = document.getElementById('tdsChart');
        if (tdsCanvas) {
            const tdsCtx = tdsCanvas.getContext('2d');
            this.charts.tds = new Chart(tdsCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'TDS Raw (ppm)',
                        data: [],
                        borderColor: chartColors.line,
                        backgroundColor: 'rgba(136, 192, 208, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.25
                    }, {
                        label: 'TDS Comp (ppm)',
                        data: [],
                        borderColor: chartColors.accent,
                        backgroundColor: 'rgba(129, 161, 193, 0.05)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.25
                    }, {
                        label: 'Sıcaklık (°C)',
                        data: [],
                        borderColor: chartColors.high,
                        backgroundColor: 'rgba(191, 97, 106, 0.06)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.25,
                        yAxisID: 'yTemp'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: true }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { color: chartColors.text },
                            title: { display: true, text: 'ppm' }
                        },
                        yTemp: {
                            position: 'right',
                            ticks: { color: chartColors.text },
                            grid: { drawOnChartArea: false },
                            title: { display: true, text: '°C' }
                        },
                        x: {
                            ticks: { color: chartColors.text }
                        }
                    }
                }
            });
        }

        // Chart 2: Weather Time Series (API)
        const weatherCanvas = document.getElementById('weatherChart');
        if (weatherCanvas) {
            const weatherCtx = weatherCanvas.getContext('2d');
            this.charts.weather = new Chart(weatherCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Hava Sıcaklığı (°C)',
                        data: [],
                        borderColor: chartColors.accent,
                        backgroundColor: 'rgba(129, 161, 193, 0.08)',
                        borderWidth: 2,
                        tension: 0.25,
                        fill: true
                    }, {
                        label: 'Nem (%)',
                        data: [],
                        borderColor: chartColors.low,
                        backgroundColor: 'rgba(163, 190, 140, 0.05)',
                        borderWidth: 2,
                        tension: 0.25,
                        fill: false
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: true }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { color: chartColors.text }
                        },
                        x: {
                            ticks: { color: chartColors.text }
                        }
                    }
                }
            });
        }

        // Farmer mode charts
        this.initFarmerCharts(chartColors);
    }

    updateCharts() {
        if (this.charts.tds) {
            const recent = this.serverHistory.slice(-40);
            this.charts.tds.data.labels = recent.map((row) => {
                const d = new Date(row.timestamp);
                return Number.isNaN(d.getTime())
                    ? '-'
                    : d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            });
            this.charts.tds.data.datasets[0].data = recent.map((row) => row.tdsRaw);
            this.charts.tds.data.datasets[1].data = recent.map((row) => row.tdsComp);
            this.charts.tds.data.datasets[2].data = recent.map((row) => row.temp);
            this.charts.tds.update();
        }

        if (this.charts.weather) {
            const recentWeather = this.weatherHistory.slice(-24);
            this.charts.weather.data.labels = recentWeather.map((row) => {
                const d = new Date(row.timestamp);
                return Number.isNaN(d.getTime())
                    ? '-'
                    : d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            });
            this.charts.weather.data.datasets[0].data = recentWeather.map((row) => row.temperature);
            this.charts.weather.data.datasets[1].data = recentWeather.map((row) => row.humidity);
            this.charts.weather.update();
        }
    }

    // ====== DATA GENERATION ======
    generateDateLabels(days) {
        const labels = [];
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            labels.push(date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' }));
        }
        return labels;
    }

    calculateRiskDistribution() {
        const counts = { low: 0, medium: 0, high: 0 };
        this.sensors.forEach(s => counts[s.riskLevel]++);
        return [counts.low, counts.medium, counts.high];
    }

    getTopSensorNames(count) {
        return this.sensors
            .slice()
            .sort((a, b) => b.tds - a.tds)
            .slice(0, count)
            .map(s => s.name.substring(0, 10));
    }

    getTopSensorValues(count) {
        return this.sensors
            .slice()
            .sort((a, b) => b.tds - a.tds)
            .slice(0, count)
            .map(s => s.tds);
    }

    // ====== FARMER CHARTS ======
    initFarmerCharts(chartColors) {
        const cropToleranceCtx = document.getElementById('cropToleranceChart')?.getContext('2d');
        if (cropToleranceCtx) {
            const cropData = this.getCropToleranceData();
            this.charts.cropTolerance = new Chart(cropToleranceCtx, {
                type: 'bar',
                data: {
                    labels: cropData.labels,
                    datasets: [{
                        label: 'Tuzluluk Toleransı',
                        data: cropData.values,
                        backgroundColor: chartColors.accent,
                        borderColor: chartColors.accent,
                        borderWidth: 1,
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y',
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { beginAtZero: true, ticks: { color: chartColors.text } },
                        y: { ticks: { color: chartColors.text } }
                    }
                }
            });
        }

        const cropPhCtx = document.getElementById('cropPhChart')?.getContext('2d');
        if (cropPhCtx) {
            const cropPh = this.getCropPhData();
            this.charts.cropPh = new Chart(cropPhCtx, {
                type: 'bar',
                data: {
                    labels: cropPh.labels,
                    datasets: [{
                        label: 'Tuzluluk',
                        data: cropPh.salinity,
                        backgroundColor: chartColors.medium
                    }, {
                        label: 'pH',
                        data: cropPh.ph,
                        backgroundColor: chartColors.accent
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom' } },
                    scales: {
                        x: { ticks: { color: chartColors.text } },
                        y: { beginAtZero: true, ticks: { color: chartColors.text } }
                    }
                }
            });
        }

        const yieldCtx = document.getElementById('yieldDropChart')?.getContext('2d');
        if (yieldCtx) {
            const trend = this.getYieldTrendData();
            this.charts.yield = new Chart(yieldCtx, {
                type: 'line',
                data: {
                    labels: trend.labels,
                    datasets: [{
                        label: 'Verim Endeksi',
                        data: trend.values,
                        borderColor: chartColors.high,
                        backgroundColor: 'rgba(191, 97, 106, 0.12)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointBackgroundColor: chartColors.high
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: false, ticks: { color: chartColors.text } },
                        x: { ticks: { color: chartColors.text } }
                    }
                }
            });
        }

        const moistureCtx = document.getElementById('soilMoistureChart')?.getContext('2d');
        if (moistureCtx) {
            const moisture = this.getMoistureValue();
            this.charts.moisture = new Chart(moistureCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Nem', 'Kalan'],
                    datasets: [{
                        data: [moisture, 100 - moisture],
                        backgroundColor: [chartColors.low, chartColors.grid],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '70%',
                    plugins: {
                        legend: { display: false },
                        tooltip: { enabled: false }
                    }
                }
            });
        }
    }

    updateFarmerCharts() {
        if (this.charts.cropTolerance) {
            const cropData = this.getCropToleranceData();
            this.charts.cropTolerance.data.labels = cropData.labels;
            this.charts.cropTolerance.data.datasets[0].data = cropData.values;
            this.charts.cropTolerance.update();
        }
        if (this.charts.cropPh) {
            const cropPh = this.getCropPhData();
            this.charts.cropPh.data.labels = cropPh.labels;
            this.charts.cropPh.data.datasets[0].data = cropPh.salinity;
            this.charts.cropPh.data.datasets[1].data = cropPh.ph;
            this.charts.cropPh.update();
        }
        if (this.charts.yield) {
            const trend = this.getYieldTrendData();
            this.charts.yield.data.labels = trend.labels;
            this.charts.yield.data.datasets[0].data = trend.values;
            this.charts.yield.update();
        }
        if (this.charts.moisture) {
            const moisture = this.getMoistureValue();
            this.charts.moisture.data.datasets[0].data = [moisture, 100 - moisture];
            this.charts.moisture.update();
        }
    }

    getAverageTds() {
        const source = this.filteredSensors.length ? this.filteredSensors : this.sensors;
        if (!source.length) return 0;
        return source.reduce((sum, s) => sum + s.tds, 0) / source.length;
    }

    getCropToleranceData() {
        const crops = [
            { name: 'Buğday', tolerance: 2200 },
            { name: 'Arpa', tolerance: 3000 },
            { name: 'Mısır', tolerance: 1700 },
            { name: 'Ayçiçek', tolerance: 2500 },
            { name: 'Patates', tolerance: 1400 }
        ];
        const avgTds = this.getAverageTds();
        return {
            labels: crops.map(c => c.name),
            values: crops.map(c => Math.max(200, Math.round(c.tolerance - (avgTds * 0.35))))
        };
    }

    getCropPhData() {
        const crops = ['Buğday', 'Arpa', 'Mısır', 'Nohut', 'Şekerpancarı'];
        const avgTds = this.getAverageTds();
        const latest = this.serverHistory.slice(-5);
        const baseSalinity = latest.length
            ? Math.round(latest.reduce((sum, row) => sum + (Number(row.tds) || 0), 0) / latest.length)
            : Math.max(0, Math.round(avgTds));
        const avgMoisture = latest.length
            ? latest.reduce((sum, row) => sum + (Number(row.moisture) || 0), 0) / latest.length
            : 50;
        const basePh = Math.max(5.5, Math.min(8.2, 7 - ((avgMoisture - 50) / 100)));
        return {
            labels: crops,
            salinity: crops.map(() => baseSalinity),
            ph: crops.map(() => Number(basePh.toFixed(2)))
        };
    }

    getYieldTrendData() {
        const source = this.serverHistory.slice(-8);
        if (!source.length) {
            return { labels: [], values: [] };
        }
        const labels = source.map((row, i) => {
            const d = new Date(row.timestamp);
            if (Number.isNaN(d.getTime())) return `Veri ${i + 1}`;
            return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
        });
        const values = source.map((row) => {
            const tds = Number(row.tds) || 0;
            return Math.max(0, Math.min(100, Math.round(100 - (tds / 50))));
        });
        return { labels, values };
    }

    getMoistureValue() {
        const source = this.serverHistory.slice(-10);
        if (!source.length) return 0;
        const withMoisture = source
            .map((row) => Number(row.moisture))
            .filter((val) => Number.isFinite(val));
        if (!withMoisture.length) return 0;
        const avg = withMoisture.reduce((sum, val) => sum + val, 0) / withMoisture.length;
        return Math.max(0, Math.min(100, Math.round(avg)));
    }

    // ====== STATS UPDATE ======
    updateStats() {
        const count = this.filteredSensors.length;
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        
        if (count === 0) {
            setText('sensorCount', '0');
            setText('avgTds', '-');
            setText('maxTds', '-');
            setText('minTds', '-');
            setText('stdTds', '-');
            setText('anomalyRate', '-');
            return;
        }
        
        const tdsValues = this.filteredSensors.map(s => s.tds);
        const avgTds = tdsValues.reduce((a, b) => a + b, 0) / count;
        const maxTds = Math.max(...tdsValues);
        const minTds = Math.min(...tdsValues);
        const stdTds = this.calculateStdDev(tdsValues);
        const anomalyRate = ((count * 0.15).toFixed(0) + ' / ' + count);
        
        setText('sensorCount', count);
        setText('avgTds', avgTds.toFixed(0));
        setText('maxTds', maxTds.toFixed(0));
        setText('minTds', minTds.toFixed(0));
        setText('stdTds', stdTds.toFixed(1));
        setText('anomalyRate', anomalyRate);
    }

    calculateStdDev(values) {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    updateTimestamp() {
        const now = new Date();
        const formatted = now.toLocaleString('tr-TR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        document.getElementById('lastUpdate').textContent = formatted;
    }

    // ====== MAIN RENDER ======
    render() {
        // Filter sensors by active risks
        this.filteredSensors = this.sensors.filter(s => 
            this.activeRisks.includes(s.riskLevel)
        );
        
        // Update UI elements
        this.updateSensorSelect();
        this.updateStats();
        
        // Update map if open
        if (this.mapOpen && window.mapRenderer) {
            window.mapRenderer.filterByRisk(this.filteredSensors);
            if (this.selectedSensor) {
                window.mapRenderer.highlightSensor(this.selectedSensor);
            }
        }
        
        // Update charts
        this.updateCharts();
        this.updateFarmerCharts();
        
        // Update user-facing indicators for obruk risk and salinization
        this.updateIndicators();
    }

    /**
     * Create simple 1-2 sentence comments for top sensors and show in main area
     * Rule-based: compare last value to recent average and produce short note
     */
    updateIndicators() {
        // Obruk risk: if any sensors high risk in filtered set, mark accordingly
        const obriskEl = document.getElementById('obriskIndicator');
        const salEl = document.getElementById('salinityIndicator');
        if (!obriskEl || !salEl) return;

        const highCount = this.filteredSensors.filter(s => s.riskLevel === 'high').length;
        const total = this.filteredSensors.length || 1;
        const highPct = Math.round((highCount / total) * 100);

        // Simple user-facing wording
        let obriskTextKey = 'indicator.low';
        if (highPct >= 50) obriskTextKey = 'indicator.high';
        else if (highPct >= 20) obriskTextKey = 'indicator.medium';
        const obriskText = this.t(obriskTextKey);

        // Salinization indicator: average TDS across filtered sensors
        const avgTds = this.getAverageTds();
        let salText = 'Normal';
        if (avgTds > 2500) salText = 'Yüksek Tuzlanma';
        else if (avgTds > 1800) salText = 'Orta Tuzlanma';

        // Fill elements
        obriskEl.querySelector('.indicator-value').textContent = `${obriskText} (${highPct}%)`;
        const obriskDescKey = highPct >= 50 ? 'indicator.obrukHigh' : (highPct >= 20 ? 'indicator.obrukMedium' : 'indicator.obrukLow');
        obriskEl.querySelector('.indicator-desc').textContent = this.t(obriskDescKey);

        salEl.querySelector('.indicator-value').textContent = `${Math.round(avgTds)} ppm`;
        const salDescKey = salText === 'Normal' ? 'indicator.salinityNormal' : (salText === 'Orta Tuzlanma' ? 'indicator.salinityMedium' : 'indicator.salinityHigh');
        salEl.querySelector('.indicator-desc').textContent = this.t(salDescKey);

        const obriskFill = obriskEl.querySelector('[data-meter="obrisk"]');
        const salFill = salEl.querySelector('[data-meter="salinity"]');
        if (obriskFill) obriskFill.style.width = `${Math.min(100, Math.max(10, highPct))}%`;
        if (salFill) {
            const salPct = avgTds > 2500 ? 90 : (avgTds > 1800 ? 60 : 30);
            salFill.style.width = `${salPct}%`;
        }
    }
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('📍 DOM loaded, initializing application...');
    window.app = new App();
});
