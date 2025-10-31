// NeuroSky (HC-05) + L298N — Atenção controla PWM entre 55..80 (sem rampa).
// Piscadas: 3 em ≤2s => BOOST por 0,5s (só dispara se boostPct==100).
// CHECKPOINT: dispara na metade das voltas (VOLTAS_TOTAL/2) e termina quando relax >= RELAX_OK.
// Voltas: sensor MH no D2 com polling, one-shot + debounce.

#include <SoftwareSerial.h>

// ================== BLUETOOTH / THINKGEAR ==================
#define BT_RX 11
#define BT_TX 10
SoftwareSerial BT(BT_RX, BT_TX);

#define BAUD_BT   57600
#define BAUD_USB  115200
#define SYNC      0xAA

// ================== PONTE H (L298N) ==================
const int ENA = 9;   // PWM
const int IN1 = 3;   // direção
const int IN2 = 4;   // direção

// ================== PWM LIMITES ==================
const int MIN_PWM = 50;
const int MAX_PWM = 80;
const int BOOST_PWM = (int)min((long)(MAX_PWM * 12L / 10L), 255L); // ~+20%

// ================== TOTAL DE VOLTAS (SITE LÊ DAQUI) ==================
const uint16_t VOLTAS_TOTAL = 20;   // <<< ajuste aqui

// ================== BLINK / BOOST (janela de disparo) ==================
const unsigned long BLINK_GAP_MS = 2000;
const unsigned long BOOST_MS      = 500;
int  blinkCount           = 0;
unsigned long lastBlinkMs = 0;
bool boostAtivo           = false;
unsigned long boostFimMs  = 0;

// ================== BOOST ACUMULATIVO (NOVO/RESTAURADO) ==================
uint8_t boostPct = 0;                           // 0..100
const unsigned long BOOST_TICK_MS = 20000UL;    // +5 a cada 20s
unsigned long lastBoostTickMs = 0;              // relógio do tick

inline void boostAdd5() {
  if (boostPct < 100) {
    boostPct = (boostPct + 5 > 100) ? 100 : (boostPct + 5);
  }
}

// ================== BLINK POR RAW ==================
const int   THRESHOLD   = 600;
const int   REFRACT_MS  = 250;
const int   BASE_WIN    = 64;
const int   MIN_PEAK_MS = 15;
const int   BLINK_MIN   = 50;
const int   BLINK_MAX   = 300;

long lastBlinkRawMs = -10000;
int  baseBuf[BASE_WIN];
int  baseIdx = 0;
long baseSum = 0;
bool baseFilled = false;
int  aboveCount = 0;

// ================== PARSER ==================
uint8_t payload[169];
uint8_t plength=0, pindex=0, csum=0, csumRx=0;
enum S { SYNC1, SYNC2, LEN, DATA, CHK }; S st = SYNC1;

// ================== MÉTRICAS ==================
int sinal        = -1;   // 0=ótimo; 200=sem contato
int atencao      = -1;   // 0..100
int relaxamento  = -1;   // 0..100
int atencaoSuave = 0;    // 0..100

// ================== LINK / TEMPOS ==================
unsigned long lastByteMs    = 0;
unsigned long lastSignalMs  = 0;
unsigned long lastDecayMs   = 0;
bool linkAtivo() { return (millis() - lastByteMs) < 1500; }

// ================== CHECKPOINT (metade das voltas) ==================
const int RELAX_OK = 60;
bool checkpointAtivo = false;
bool checkpointDisparado = false; // dispara uma vez por corrida

// ================== VOLTAS — POLLING ==================
const uint8_t IR_PIN = 2;           // DO do MH no D2
const bool    USE_PULLUP = false;   // true se flutuar
const bool    ACTIVE_LOW = true;    // se contou em LOW, deixe true
const unsigned long DEBOUNCE_MS = 60;

volatile unsigned long lapCount = 0;

int irIdleLevel, irActiveLevel;
int lastLevel = -1;
bool armed = true;
unsigned long lastEdgeMs = 0;

// ---------- Utilidades ----------
void resetParser() { st = SYNC1; plength=0; pindex=0; csum=0; }

int updateBaseline(int sample) {
  if (!baseFilled && baseIdx < BASE_WIN) {
    baseBuf[baseIdx++] = sample; baseSum += sample;
    if (baseIdx == BASE_WIN) baseFilled = true;
  } else if (baseFilled) {
    baseSum -= baseBuf[baseIdx];
    baseBuf[baseIdx] = sample;
    baseSum += sample;
    baseIdx = (baseIdx + 1) % BASE_WIN;
  }
  int n = baseFilled ? BASE_WIN : (baseIdx > 0 ? baseIdx : 1);
  return baseSum / n;
}

void onValidBlink(int strength) {
  if (strength < BLINK_MIN || strength > BLINK_MAX) return;

  Serial.print(F("{\"evento\":\"blink\",\"forca\":"));
  Serial.print(strength);
  Serial.print(F(",\"voltasTotal\":")); Serial.print(VOLTAS_TOTAL);
  Serial.println(F("}"));

  unsigned long now = millis();
  if (blinkCount == 0) blinkCount = 1;
  else blinkCount = (now - lastBlinkMs <= BLINK_GAP_MS) ? (blinkCount + 1) : 1;
  lastBlinkMs = now;

  // Disparo do boost SOMENTE se o tanque estiver cheio (100%)
  if (blinkCount >= 3) {
    blinkCount = 0;
    if (boostPct == 100) {
      boostAtivo = true;
      boostFimMs = now + BOOST_MS;
      boostPct = 0; // consome o boost
      Serial.print(F("{\"evento\":\"boost\""));
      Serial.print(F(",\"voltasTotal\":")); Serial.print(VOLTAS_TOTAL);
      Serial.println(F("}"));
    }
  }
}

void processRawSample(int raw) {
  static int baseline = 0;
  baseline = updateBaseline(raw);
  int diff  = raw - baseline;
  int adiff = (diff >= 0) ? diff : -diff;

  if (adiff >= THRESHOLD) aboveCount++;
  else aboveCount = 0;

  if (aboveCount > 0) {
    long dt = millis() - lastBlinkRawMs;
    if (dt > REFRACT_MS && aboveCount * 2 >= MIN_PEAK_MS) {
      lastBlinkRawMs = millis();
      int strength = adiff / 4; if (strength > 255) strength = 255;
      onValidBlink(strength);
      aboveCount = 0;
    }
  }
}

// ====== Decaimento da ATENÇÃO ======
#define DECAY_PER_SEC 20
#define DECAY_TICK_MS 100
void updateAttentionDecay() {
  unsigned long now = millis();
  if (atencaoSuave < 0) atencaoSuave = max(0, atencao);

  bool semSinal = (sinal >= 200) || !linkAtivo();

  if (semSinal) {
    unsigned long elapsed = now - lastDecayMs;
    if (elapsed >= DECAY_TICK_MS) {
      int dec = (int)((DECAY_PER_SEC * elapsed) / 1000);
      if (dec < 1) dec = 1;
      atencaoSuave = max(0, atencaoSuave - dec);
      lastDecayMs = now;
    }
  } else {
    if (atencao >= 0) atencaoSuave = atencao;
    lastDecayMs = now;
  }
}

// ====== Parser ThinkGear ======
void processPayload(uint8_t* buf, uint8_t len) {
  for (uint8_t i = 0; i < len; ) {
    uint8_t code = buf[i++];
    if (code == 0x55) continue; // EXCODE

    if (code == 0x02 || code == 0x04 || code == 0x05 || code == 0x16) {
      if (i >= len) break;
      uint8_t val = buf[i++];
      if (code == 0x02) { sinal = val; lastSignalMs = millis(); }
      else if (code == 0x04) { atencao = val; }
      else if (code == 0x05) { relaxamento = val; }
      else if (code == 0x16) { onValidBlink(val); }
    } else {
      if (i >= len) break;
      uint8_t vlen = buf[i++];
      if (i + vlen > len) break;

      if (code == 0x80 && vlen == 0x02 && (i + 1) < len) {
        int hi  = (int8_t)buf[i++];
        int lo  = buf[i++] & 0xFF;
        int raw = (hi << 8) | lo;
        processRawSample(raw);
      } else {
        i += vlen;
      }
    }
  }
}

// ====== Aplicar PWM ======
void aplicarPWM(int pwmOut) {
  pwmOut = constrain(pwmOut, 0, 255);
  analogWrite(ENA, pwmOut);
}

// ====== VOLTAS: inicialização ======
void initLapSensor(){
  pinMode(IR_PIN, USE_PULLUP ? INPUT_PULLUP : INPUT);
  irIdleLevel   = ACTIVE_LOW ? HIGH : LOW;
  irActiveLevel = ACTIVE_LOW ? LOW  : HIGH;
  lastLevel = digitalRead(IR_PIN);
  armed = true;
  lastEdgeMs = 0;
}

// ====== VOLTAS: serviço por polling ======
void serviceLapSensor(){
  int level = digitalRead(IR_PIN);
  unsigned long now = millis();

  if (level != lastLevel){
    if (now - lastEdgeMs >= DEBOUNCE_MS){
      lastEdgeMs = now;
      if (level == irActiveLevel && armed){
        lapCount++;
        // +5 no boost a cada volta (acúmulo)
        boostAdd5();

        Serial.print(F("{\"evento\":\"lap\",\"voltas\":"));
        Serial.print(lapCount);
        Serial.print(F(",\"voltasTotal\":"));
        Serial.print(VOLTAS_TOTAL);
        Serial.println(F("}"));

        armed = false;
      }
    }
    lastLevel = level;
  }

  if (!armed && level == irIdleLevel){
    armed = true;
  }
}

// ================== SETUP ==================
void setup() {
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, 0);

  Serial.begin(BAUD_USB);
  BT.begin(BAUD_BT);

  pinMode(13, OUTPUT); // debug opcional
  initLapSensor();

  lastDecayMs = millis();
  lastBoostTickMs = millis(); // inicia relógio do boost 20s

  Serial.print(F("{\"status\":\"iniciando\",\"bt\":57600,\"usb\":115200"));
  Serial.print(F(",\"voltasTotal\":")); Serial.print(VOLTAS_TOTAL);
  Serial.println(F("}"));
}

// ================== LOOP ==================
void loop() {
  // --- Recepção BT / Parser ---
  while (BT.available()) {
    uint8_t b = BT.read();
    lastByteMs = millis();

    switch (st) {
      case SYNC1: if (b == SYNC) st = SYNC2; break;
      case SYNC2: st = (b == SYNC) ? LEN : SYNC1; break;
      case LEN:
        plength = b;
        if (plength == 0 || plength > sizeof(payload)) resetParser();
        else { pindex=0; csum=0; st=DATA; }
        break;
      case DATA:
        payload[pindex++] = b; csum += b;
        if (pindex >= plength) st = CHK;
        break;
      case CHK:
        csumRx = b; csum = 0xFF - csum;
        if (csum == csumRx) processPayload(payload, plength);
        resetParser();
        break;
    }
  }

  // Sem contato se >2s sem 0x02 ou link caiu
  if ((millis() - lastSignalMs) > 2000 || !linkAtivo()) {
    sinal = 200;
  }

  // Decaimento
  updateAttentionDecay();

  // BOOST janela ativa termina?
  if (boostAtivo && millis() >= boostFimMs) boostAtivo = false;

  // --------- BOOST ACUMULATIVO por tempo (a cada 20s) ---------
  if (millis() - lastBoostTickMs >= BOOST_TICK_MS) {
    lastBoostTickMs += BOOST_TICK_MS;
    boostAdd5(); // +5 a cada 20s (até 100)
  }
  // ------------------------------------------------------------

  // ---------- CHECKPOINT POR METADE DAS VOLTAS ----------
  if (!checkpointDisparado && lapCount >= (VOLTAS_TOTAL / 2)) {
    checkpointAtivo = true;
    checkpointDisparado = true;
    Serial.print(F("{\"evento\":\"checkpoint\""));
    Serial.print(F(",\"voltasTotal\":")); Serial.print(VOLTAS_TOTAL);
    Serial.println(F("}"));
  }
  if (checkpointAtivo && relaxamento >= RELAX_OK) {
    checkpointAtivo = false;
    Serial.print(F("{\"evento\":\"checkpoint_end\""));
    Serial.print(F(",\"voltasTotal\":")); Serial.print(VOLTAS_TOTAL);
    Serial.println(F("}"));
  }
  // ------------------------------------------------------

  // Voltas
  serviceLapSensor();

  // PWM alvo
  int targetPWM = 0;
  if (boostAtivo) {
    targetPWM = BOOST_PWM;
  } else if (checkpointAtivo) {
    targetPWM = 0;
  } else if (sinal < 200 && linkAtivo() && atencaoSuave > 0) {
    targetPWM = map(constrain(atencaoSuave, 1, 100), 1, 100, MIN_PWM, MAX_PWM);
  } else {
    targetPWM = (atencaoSuave <= 0) ? 0 : map(atencaoSuave, 1, 100, MIN_PWM, MAX_PWM);
  }
  aplicarPWM(targetPWM);

  // Log enxuto a cada 500 ms
  static unsigned long lastDbg=0;
  unsigned long now = millis();
  if (now - lastDbg >= 500) {
    lastDbg = now;
    int attLog = checkpointAtivo ? 0 : atencao;
    Serial.print(F("{\"link\":"));          Serial.print(linkAtivo()?"true":"false");
    Serial.print(F(",\"conexao\":"));       Serial.print(sinal);
    Serial.print(F(",\"lado\":\"policia\""));
    Serial.print(F(",\"concentracao\":"));  Serial.print(attLog);
    Serial.print(F(",\"relaxamento\":"));   Serial.print(relaxamento);
    Serial.print(F(",\"checkpoint\":"));    Serial.print(checkpointAtivo ? 1 : 0);
    Serial.print(F(",\"boost\":"));         Serial.print((int)boostPct);   // 0..100 para o site
    Serial.print(F(",\"pwm\":"));           Serial.print(targetPWM);
    Serial.print(F(",\"voltas\":"));        Serial.print(lapCount);
    Serial.print(F(",\"voltasTotal\":"));   Serial.print(VOLTAS_TOTAL);
    Serial.println(F("}"));
  }
}
