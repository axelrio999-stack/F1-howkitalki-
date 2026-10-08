let peer = null;
let localStream = null;
let activeCalls = {};
let activeDataConns = {};
let knownPeers = new Set();
let myChannel = "";
let rogerBeepEnabled = true;
let masterVolume = 0.5;

// অডিও কনটেক্সট ইনিশিয়ালাইজেশন
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const lcdScreen = document.getElementById('lcdScreen');
const channelText = document.getElementById('channelText');
const freqText = document.getElementById('freqText');
const statusText = document.getElementById('statusText');
const statusLed = document.getElementById('statusLed');
const pttBtn = document.getElementById('pttBtn');
const memberCount = document.getElementById('memberCount');
const volSlider = document.getElementById('volSlider');
const volVal = document.getElementById('volVal');
const hintText = document.getElementById('hintText');
const btnRoger = document.getElementById('btnRoger');

// ভলিউম স্লাইডার ইভেন্ট হ্যান্ডলার
volSlider.addEventListener('input', (e) => {
    masterVolume = e.target.value / 100;
    volVal.textContent = e.target.value + '%';
    
    document.querySelectorAll('#audioContainer audio').forEach(audio => {
        audio.volume = Math.min(masterVolume, 1.0);
    });
});

function initAudio() {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// স্কোয়েল্চ স্ট্যাটিক নয়েজ তৈরি (Static Squelch Noise)
function playStaticNoise(duration = 140) {
    initAudio();
    const bufferSize = audioCtx.sampleRate * (duration / 1000);
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.12 * masterVolume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + (duration / 1000));

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    noise.start();
}

// দুই-টোন রজার বিপ (Roger Beep)
function playRogerBeep() {
    if (!rogerBeepEnabled) return;
    initAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1680, audioCtx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.18 * masterVolume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.22);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.22);
}

// অ্যালার্ট টোন (Alert Tone)
function playAlertSound() {
    initAudio();
    let count = 0;
    const timer = setInterval(() => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = count % 2 === 0 ? 950 : 1350;
        gain.gain.setValueAtTime(0.15 * masterVolume, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.08);
        count++;
        if (count > 6) clearInterval(timer);
    }, 80);
}

// চ্যানেলে যুক্ত হওয়ার ফাংশন
async function joinSquadChannel() {
    const raw = document.getElementById('channelInput').value.trim().toUpperCase();
    if (!raw) return alert("type the channels name ");

    myChannel = raw.replace(/[^A-Z0-9]/g, '');
    document.getElementById('joinBtn').disabled = true;
    document.getElementById('channelInput').disabled = true;
    statusText.textContent = "Connecting...";

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: true, noiseSuppression: true } 
        });
        localStream.getAudioTracks()[0].enabled = false;
    } catch (err) {
        alert("the microphone is not alowed!");
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('channelInput').disabled = false;
        return;
    }

    const myPeerId = "wt_" + myChannel + "_" + Math.floor(1000 + Math.random() * 9000);
    peer = new Peer(myPeerId);

    peer.on('open', (id) => {
        channelText.textContent = "CH-" + myChannel;
        freqText.textContent = "446." + Math.floor(100 + Math.random() * 800) + " MHz";
        statusText.textContent = "STANDBY (online )";
        pttBtn.removeAttribute('disabled');
        hintText.textContent = "click the PTT or Spacebar button";
        document.getElementById('channelBox').style.display = 'none';
        
        playStaticNoise(150);
        setTimeout(playRogerBeep, 160);

        startMeshNetwork();
    });

    peer.on('call', (call) => {
        call.answer(localStream);
        setupIncomingAudio(call);
    });

    peer.on('connection', (conn) => {
        setupDataConnection(conn);
    });
}

function setupIncomingAudio(call) {
    activeCalls[call.peer] = call;
    updateSquadCount();

    call.on('stream', (stream) => {
        let audio = document.getElementById('audio_' + call.peer);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'audio_' + call.peer;
            audio.autoplay = true;
            document.getElementById('audioContainer').appendChild(audio);
        }
        audio.volume = Math.min(masterVolume, 1.0);
        audio.srcObject = stream;
    });

    call.on('close', () => {
        const el = document.getElementById('audio_' + call.peer);
        if (el) el.remove();
        delete activeCalls[call.peer];
        updateSquadCount();
    });
}

function setupDataConnection(conn) {
    activeDataConns[conn.peer] = conn;
    conn.on('data', (data) => {
        if (data.type === 'PEER_DISCOVERY') {
            data.peers.forEach(peerId => {
                if (peerId !== peer.id && !activeCalls[peerId]) {
                    connectToTeamMember(peerId);
                }
            });
        } else if (data.type === 'TX_STATE') {
            handleRemoteTxState(data.isTalking);
        } else if (data.type === 'ALERT_SIGNAL') {
            playAlertSound();
        }
    });

    conn.on('open', () => {
        knownPeers.add(conn.peer);
        conn.send({
            type: 'PEER_DISCOVERY',
            peers: Array.from(knownPeers)
        });
        updateSquadCount();
    });

    conn.on('close', () => {
        delete activeDataConns[conn.peer];
        knownPeers.delete(conn.peer);
        updateSquadCount();
    });
}

function connectToTeamMember(targetPeerId) {
    if (targetPeerId === peer.id || activeCalls[targetPeerId]) return;

    const conn = peer.connect(targetPeerId);
    setupDataConnection(conn);

    const call = peer.call(targetPeerId, localStream);
    setupIncomingAudio(call);
}

function startMeshNetwork() {
    knownPeers.add(peer.id);
    setInterval(() => {
        Object.values(activeDataConns).forEach(conn => {
            if (conn.open) {
                conn.send({
                    type: 'PEER_DISCOVERY',
                    peers: Array.from(knownPeers)
                });
            }
        });
    }, 3000);
}

function updateSquadCount() {
    const count = Object.keys(activeCalls).length + 1;
    memberCount.textContent = "SQUAD: " + count;
}

function handleRemoteTxState(isTalking) {
    if (isTalking) {
        lcdScreen.className = 'lcd-screen receiving';
        statusLed.className = 'led-indicator rx';
        statusText.textContent = "RX RECEIVING...";
        playStaticNoise(90);
    } else {
        lcdScreen.className = 'lcd-screen';
        statusLed.className = 'led-indicator';
        statusText.textContent = "STANDBY (online)";
        playStaticNoise(100);
        setTimeout(playRogerBeep, 110);
    }
}

function startTransmission() {
    if (!localStream || pttBtn.disabled) return;
    initAudio();

    localStream.getAudioTracks()[0].enabled = true;
    pttBtn.classList.add('active');
    lcdScreen.className = 'lcd-screen transmitting';
    statusLed.className = 'led-indicator tx';
    statusText.textContent = "TX TRANSMITTING...";
    playStaticNoise(80);

    broadcastData({ type: 'TX_STATE', isTalking: true });
}

function stopTransmission() {
    if (!localStream || pttBtn.disabled) return;

    localStream.getAudioTracks()[0].enabled = false;
    pttBtn.classList.remove('active');
    lcdScreen.className = 'lcd-screen';
    statusLed.className = 'led-indicator';
    statusText.textContent = "STANDBY (online)";

    playStaticNoise(120);
    setTimeout(playRogerBeep, 130);

    broadcastData({ type: 'TX_STATE', isTalking: false });
}

function broadcastData(data) {
    Object.values(activeDataConns).forEach(conn => {
        if (conn.open) conn.send(data);
    });
}

function sendAlertTone() {
    if (!peer) return;
    playAlertSound();
    broadcastData({ type: 'ALERT_SIGNAL' });
}

function toggleRogerBeep() {
    rogerBeepEnabled = !rogerBeepEnabled;
    document.getElementById('rogerStatus').textContent = `BEEP: ${rogerBeepEnabled ? 'ON' : 'OFF'}`;
    playStaticNoise(70);
}

// মাউস ও টাচ কন্ট্রোল
pttBtn.addEventListener('mousedown', startTransmission);
window.addEventListener('mouseup', stopTransmission);

pttBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startTransmission();
});
window.addEventListener('touchend', stopTransmission);

// কীবোর্ড কন্ট্রোল
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        startTransmission();
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        stopTransmission();
    }
});