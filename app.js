var firebaseConfig = {
            apiKey: "AIzaSyDuQEgk_86c6plQB5BNCHdRGgzHrFxPu3A",
            authDomain: "drag-timer-8333f.firebaseapp.com",
            projectId: "drag-timer-8333f",
            databaseURL: "https://drag-timer-8333f-default-rtdb.asia-southeast1.firebasedatabase.app",
            storageBucket: "drag-timer-8333f.firebasestorage.app",
            messagingSenderId: "203591345564",
            appId: "1:203591345564:web:46dafcc1767a94d835d459",
            measurementId: "G-8MZTMYNQBE"
        };

        var serverOffset = 0;
        var FB_OK = (typeof firebase !== 'undefined');
        var auth = null, db = null;
        if (FB_OK) {
            try { firebase.initializeApp(firebaseConfig); auth = firebase.auth(); db = firebase.database(); }
            catch (e) { FB_OK = false; }
        }

        /* ================= KONSTANTA & STATE ================= */
        var KMH_TO_MPH = 0.621371;
        var AUTO_START_KMH = 6.0;
        var AUTO_SENS = [4.0, 3.0, 2.2], autoSensIdx = 1, motionSm = 0;
        var keepAwake = true, goodFixes = 0, gpsHz = 0, APP_VER = '2.1';
        var GAUGE_LEN = 301.6;

        var currentUser = null;
        var racerName = "Racer";
        var soundEnabled = true;
        var currentUnit = "KM/H";

        var state = 'IDLE';             // IDLE | ARMED | RUNNING | FINISHED
        var modeType = 'dist';          // 'dist' = meter, 'speed' = target selalu disimpan dalam KM/H
        var targetValue = 201.0;
        var targetTag = '';
        var selectedPresetId = null;

        var sensorsOn = false, watchId = null, wakeLock = null, bgWatcherId = null;
        var currentLat = 0, currentLng = 0;
        var lastFix = null, lastFixWall = 0, standFix = null;
        var smoothedKmh = 0, currentSpeedKmh = 0, topSpeedKmh = 0, runTopKmh = 0;
        var speedOffset = 0;

        var launchInfo = null;
        var runSamples = [], runSplits = [], runMarks = [], lastAcc = 0;
        var accumulatedDistance = 0, runStartEpoch = 0, highResStartTime = 0, animFrameReq = null;
        var runSource = 'gps', armedAt = 0, armToken = 0, motionHits = 0, accelBase = null;
        var lastFinalTime = null;

        var map = null, userMarker = null;
        var customStartMarker = null, customFinishMarker = null, customTrackLine = null;

        var deviceToken = localStorage.getItem('racebox_device_token');
        if (!deviceToken) {
            deviceToken = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            try { localStorage.setItem('racebox_device_token', deviceToken); } catch (e) {}
        }

        var defaultPresets = [
            { id: 1, type: 'dist', val: 201, label: '201M' },
            { id: 2, type: 'dist', val: 402, label: '402M' },
            { id: 3, type: 'dist', val: 18.288, label: '60 FT' },
            { id: 4, type: 'speed', val: 60, label: '0-60 KM/H' },
            { id: 5, type: 'speed', val: 100, label: '0-100 KM/H' }
        ];
        var userPresets = null;
        try { userPresets = JSON.parse(localStorage.getItem('racebox_custom_presets')); } catch (e) { userPresets = null; }
        if (!Array.isArray(userPresets)) userPresets = defaultPresets.slice();

        /* ================= HELPER ================= */
        function $(id) { return document.getElementById(id); }
        function toDisplaySpeed(kmh) { return currentUnit === 'MPH' ? kmh * KMH_TO_MPH : kmh; }
        function offsetKmh() { return currentUnit === 'MPH' ? speedOffset / KMH_TO_MPH : speedOffset; }
        function fmtNum(n) { return String(Math.round(n * 100) / 100); }
        function esc(s) {
            return String(s).replace(/[&<>"']/g, function(c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        function safeSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
        function avatarFor(letter) {
            letter = String(letter || 'R').charAt(0).toUpperCase();
            if (!/^[A-Z0-9]$/.test(letter)) letter = 'R';
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="#000"/>' +
                '<text x="75" y="75" fill="#00F2FE" font-family="Arial" font-size="72" font-weight="bold" text-anchor="middle" dominant-baseline="central">' + letter + '</text></svg>';
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        }

        function sysModal(o) {
            $('sysIcon').innerText = o.icon || 'ℹ️';
            $('sysTitle').innerText = o.title || '';
            $('sysMsg').innerHTML = o.msg || '';
            var box = $('sysBtns'); box.innerHTML = '';
            (o.buttons || [{ text: 'OKE', cls: 'sys-primary' }]).forEach(function(b) {
                var el = document.createElement('button');
                el.className = 'setting-btn ' + (b.cls || ''); el.innerText = b.text;
                el.onclick = function() { $('sysModal').style.display = 'none'; if (b.fn) b.fn(); };
                box.appendChild(el);
            });
            $('sysModal').style.display = 'flex';
        }

        function showToast(msg, isErr) {
            var toast = $('toastNotif');
            $('toastMsg').innerText = msg;
            $('toastIcon').innerText = isErr ? '!' : '✓';
            toast.classList.toggle('err', !!isErr);
            toast.classList.add('show');
            clearTimeout(showToast._t);
            showToast._t = setTimeout(function() { toast.classList.remove('show'); }, 2800);
        }

        function hideSplash() {
            var s = $('splash'); if (!s || s.classList.contains('hide')) return;
            s.classList.add('hide'); setTimeout(function() { if (s.parentNode) s.parentNode.removeChild(s); }, 500);
        }
        setTimeout(hideSplash, 4000); // jaga-jaga kalau Firebase lambat

        /* ================= AUTH ================= */
        function authErrorText(err) {
            var map = {
                'auth/invalid-email': 'Format email tidak valid.',
                'auth/user-not-found': 'Akun tidak ditemukan. Beli akses dulu di TikTok.',
                'auth/wrong-password': 'Password salah.',
                'auth/invalid-credential': 'Email atau password salah.',
                'auth/user-disabled': 'Akun ini dinonaktifkan.',
                'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi beberapa menit.',
                'auth/network-request-failed': 'Koneksi internet bermasalah.',
                'auth/operation-not-allowed': 'Login tamu belum diaktifkan.'
            };
            return (err && map[err.code]) || ((err && err.message) ? err.message : 'Terjadi kesalahan.');
        }

        function setAuthLoading(on, which) {
            var b = $('loginBtn'), g = $('guestBtn');
            b.disabled = on; g.disabled = on;
            b.innerHTML = (on && which === 'login') ? '<span class="spinner"></span>MEMPROSES...' : 'MASUK';
        }

        function showAuthModal() { $('authModal').style.display = 'flex'; }

        function toggleAuthPass() {
            var i = $('authPassword');
            i.type = (i.type === 'password') ? 'text' : 'password';
            $('authEye').style.opacity = i.type === 'text' ? '1' : '0.6';
        }

        function loginUser() {
            if (!FB_OK) { $('authError').innerText = "Layanan login gagal dimuat. Cek internet lalu muat ulang."; return; }
            var email = $('authEmail').value.trim();
            var pass = $('authPassword').value;
            $('authError').innerText = "";
            if (!email || !pass) { $('authError').innerText = "Email dan password wajib diisi."; return; }
            setAuthLoading(true, 'login');
            auth.signInWithEmailAndPassword(email, pass).then(function() {
                localStorage.removeItem('racebox_guest_time');
                $('authPassword').value = '';
                setAuthLoading(false);
                showToast("LOGIN BERHASIL!");
            }).catch(function(err) {
                setAuthLoading(false);
                $('authError').innerText = authErrorText(err);
            });
        }

        function loginGuest() {
            if (!FB_OK) { $('authError').innerText = "Layanan login gagal dimuat. Cek internet lalu muat ulang."; return; }
            $('authError').innerText = "";
            setAuthLoading(true, 'guest');
            safeSet('racebox_guest_time', Date.now());
            auth.signInAnonymously().then(function() {
                setAuthLoading(false);
                showToast("MASUK SEBAGAI TAMU (24 JAM)");
            }).catch(function(err) {
                localStorage.removeItem('racebox_guest_time');
                setAuthLoading(false);
                $('authError').innerText = authErrorText(err);
            });
        }

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && $('authModal').style.display === 'flex' && (document.activeElement === $('authEmail') || document.activeElement === $('authPassword'))) loginUser();
        });

        /* ---- 1 akun = 1 perangkat ---- */
        var lockRef = null;
        function detachDeviceLock() { if (lockRef) { try { lockRef.off(); } catch (e) {} } var r = lockRef; lockRef = null; return r; }

        function attachDeviceLock(user) {
            detachDeviceLock();
            var ref = db.ref('device_locks/' + user.uid);
            lockRef = ref;
            ref.once('value').then(function(s) {
                var v = s.val();
                if (v && v !== deviceToken) showToast("PERANGKAT LAIN OTOMATIS DIKELUARKAN");
            }).catch(function() {}).then(function() {
                if (lockRef !== ref) return;
                ref.set(deviceToken).catch(function() {});
                ref.on('value', function(snap) {
                    var tok = snap.val();
                    if (tok && tok !== deviceToken) {
                        detachDeviceLock(); stopHostBroadcast(true);
                        localStorage.removeItem('racebox_guest_time');
                        sysModal({
                            icon: '🔒', title: 'AKUN DIPAKAI DI PERANGKAT LAIN',
                            msg: 'Akun ini baru saja login di perangkat lain. Satu akun hanya bisa aktif di <b style="color:#fff;">1 perangkat</b>, jadi sesi di HP ini diakhiri otomatis.<br><br>💡 <b style="color:var(--cyan);">Tips:</b> logout dulu dari perangkat lama sebelum pindah ke perangkat baru.',
                            buttons: [{ text: 'MENGERTI', cls: 'sys-primary', fn: function() { location.reload(); } }]
                        });
                        try { auth.signOut(); } catch (e) {}
                    }
                });
            });
        }

        function releaseDeviceLock() {
            var r = detachDeviceLock();
            if (!r) return Promise.resolve();
            return r.once('value').then(function(s) { if (s.val() === deviceToken) return r.remove(); }).catch(function() {});
        }

        function forceLogout() {
            stopHostBroadcast(true);
            localStorage.removeItem('racebox_guest_time');
            if (!auth) { location.reload(); return; }
            auth.signOut().then(function() { location.reload(); }, function() { location.reload(); });
        }

        function logoutAccount() {
            stopHostBroadcast(true);
            localStorage.removeItem('racebox_guest_time');
            releaseDeviceLock().then(function() { return auth.signOut(); }).then(function() { location.reload(); }, function() { location.reload(); });
        }

        function checkGuestExpiry(user) {
            if (!user || !user.isAnonymous) return false;
            var t = localStorage.getItem('racebox_guest_time');
            if (!t) { safeSet('racebox_guest_time', Date.now()); return false; }
            if (Date.now() - parseInt(t, 10) > 86400000) {
                if (!window.guestShown) {
                    window.guestShown = true;
                    sysModal({ icon: '⏳', title: 'MASA AKUN TAMU HABIS', msg: 'Akun Tamu hanya berlaku 24 jam. Silakan daftar atau login dengan akun resmi untuk lanjut.', buttons: [{ text: 'LOGIN AKUN RESMI', cls: 'sys-primary', fn: forceLogout }] });
                }
                return true;
            }
            return false;
        }
        setInterval(function() { if (currentUser) checkGuestExpiry(currentUser); }, 60000);

        function applyProfile(user) {
            racerName = localStorage.getItem('racebox_racer_name') || (user.isAnonymous ? "Tamu_Racer" : (user.email ? user.email.split('@')[0] : "Racer"));
            var savedPp = localStorage.getItem('racebox_racer_pp') || avatarFor(racerName);
            $('userBadgeText').innerText = racerName + (user.isAnonymous ? " (Tamu)" : "");
            $('userPpImg').src = savedPp;
            $('profilePpPreview').src = savedPp;
            $('profileNameInput').value = racerName;
            $('profilePpInput').value = savedPp.indexOf('data:') === 0 ? "" : savedPp;
            $('accountEmailText').innerText = user.isAnonymous ? "Akun Tamu (24 jam)" : user.email;
            $('resetPassBtn').style.display = user.isAnonymous ? 'none' : '';
        }

        if (auth) {
            auth.onAuthStateChanged(function(user) {
                hideSplash();
                if (user) {
                    currentUser = user;
                    if (checkGuestExpiry(user)) return;
                    applyProfile(user);
                    if (!user.isAnonymous) attachDeviceLock(user);
                    $('authModal').style.display = 'none';
                    loadHistoryFromFirebase();
                } else {
                    currentUser = null;
                    detachDeviceLock();
                    $('userBadgeText').innerText = "Belum Login";
                    showAuthModal();
                }
            });
            db.ref('.info/serverTimeOffset').on('value', function(s) { serverOffset = s.val() || 0; });
        } else {
            hideSplash(); showAuthModal();
            $('authError').innerText = "Layanan login gagal dimuat. Cek internet lalu muat ulang halaman.";
        }
        function openProfileTab() {
            if (!currentUser) { showAuthModal(); }
            else { switchTab('settings', document.querySelector('.nav-item[data-tab="settings"]')); }
        }

        function sendPasswordReset() {
            if (!currentUser || currentUser.isAnonymous || !currentUser.email) return;
            auth.sendPasswordResetEmail(currentUser.email).then(function() {
                showToast("EMAIL RESET DIKIRIM KE " + currentUser.email);
            }).catch(function(err) { showToast(authErrorText(err), true); });
        }

        function togglePwPanel() {
            if (!currentUser || currentUser.isAnonymous) { showToast("AKUN TAMU TIDAK PUNYA PASSWORD", true); return; }
            var p = $('pwPanel'); p.style.display = (p.style.display === 'none') ? 'block' : 'none';
        }
        function togglePwEye(id, btn) {
            var i = $(id); i.type = (i.type === 'password') ? 'text' : 'password';
            btn.style.opacity = i.type === 'text' ? '1' : '0.55';
        }
        function reauth(pw) {
            return currentUser.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(currentUser.email, pw));
        }
        function checkPassword() {
            var pw = $('pwCheckInput').value, r = $('pwResult');
            if (!pw) { showToast("KETIK PASSWORD DULU", true); return; }
            r.style.color = '#FFD000'; r.innerText = 'Memeriksa...';
            reauth(pw).then(function() { r.style.color = '#00FF87'; r.innerText = '✓ PASSWORD BENAR'; })
            .catch(function(err) { r.style.color = '#FF2A55'; r.innerText = '✗ ' + authErrorText(err); });
        }
        function changePassword() {
            var pw = $('pwCheckInput').value, np = $('pwNewInput').value;
            if (!pw) { showToast("ISI PASSWORD SAAT INI DULU", true); return; }
            if (np.length < 6) { showToast("PASSWORD BARU MIN. 6 KARAKTER", true); return; }
            reauth(pw).then(function() { return currentUser.updatePassword(np); }).then(function() {
                $('pwCheckInput').value = np; $('pwNewInput').value = ''; $('pwResult').innerText = '';
                showToast("PASSWORD BERHASIL DIGANTI!");
            }).catch(function(err) { showToast(authErrorText(err), true); });
        }

        function uploadPpFromGallery(input) {
            if (input.files && input.files[0]) {
                var reader = new FileReader();
                reader.onload = function(e) {
                    var base64Img = e.target.result;
                    if (!safeSet('racebox_racer_pp', base64Img)) { showToast("GAMBAR TERLALU BESAR", true); return; }
                    $('userPpImg').src = base64Img; $('profilePpPreview').src = base64Img;
                    showToast("FOTO PROFIL TERSIMPAN!");
                };
                reader.readAsDataURL(input.files[0]);
            }
        }

        function saveProfileData() {
            var name = $('profileNameInput').value.trim();
            var ppUrl = $('profilePpInput').value.trim();
            if (name) {
                racerName = name; safeSet('racebox_racer_name', name);
                $('userBadgeText').innerText = name + (currentUser && currentUser.isAnonymous ? " (Tamu)" : "");
            }
            if (ppUrl) { safeSet('racebox_racer_pp', ppUrl); $('userPpImg').src = ppUrl; $('profilePpPreview').src = ppUrl; }
            showToast("PROFIL DISIMPAN!");
        }

        function setBackground(url) { $('appShell').style.backgroundImage = "url(\"" + String(url).replace(/"/g, '%22') + "\")"; }

        function uploadBgFromGallery(input) {
            if (input.files && input.files[0]) {
                var reader = new FileReader();
                reader.onload = function(e) {
                    var b64 = e.target.result;
                    if (!safeSet('racebox_custom_bg', b64)) { showToast("GAMBAR TERLALU BESAR", true); return; }
                    setBackground(b64); showToast("WALLPAPER GALERI DIPASANG!");
                };
                reader.readAsDataURL(input.files[0]);
            }
        }
        function saveCustomBgUrl() {
            var url = $('bgUrlInput').value.trim(); if (!url) return;
            setBackground(url); safeSet('racebox_custom_bg', url); showToast("WALLPAPER LINK DIPASANG!");
        }
        function resetCustomBg() {
            $('appShell').style.backgroundImage = "none"; $('bgUrlInput').value = ""; $('bgFileInput').value = "";
            localStorage.removeItem('racebox_custom_bg'); showToast("WALLPAPER DIRESET!");
        }

        /* ================= TARGET & PRESET ================= */
        function refreshTargetLabel() {
            var el = $('targetLabel');
            if (modeType === 'dist') el.innerText = fmtNum(targetValue) + " METER" + (targetTag ? " (" + targetTag + ")" : "");
            else el.innerText = "0-" + fmtNum(toDisplaySpeed(targetValue)) + " " + currentUnit;
        }

        function setTarget(type, val, tag) {
            modeType = type; targetValue = val; targetTag = tag || '';
            if (state !== 'RUNNING' && state !== 'ARMED') accumulatedDistance = 0;
            refreshTargetLabel(); updateUI();
        }

        function renderPresetsGrid() {
            var html = '';
            for (var i = 0; i < userPresets.length; i++) {
                var p = userPresets[i];
                html += '<button class="btn-preset' + (p.id === selectedPresetId ? ' active' : '') + '" onclick="selectPreset(' + p.id + ')">' + esc(p.label) + '</button>';
            }
            html += '<button class="btn-preset' + (targetTag === 'CUSTOM' ? ' active' : '') + '" onclick="openCustomDistanceModal()">CUSTOM M</button>';
            html += '<button class="btn-preset" style="color:var(--green);" onclick="openPresetManagerModal()">+ KELOLA</button>';
            $('presetsGridContainer').innerHTML = html;
        }

        function selectPreset(id) {
            if (state === 'RUNNING') { showToast("STOP RUN DULU", true); return; }
            var p = null;
            for (var i = 0; i < userPresets.length; i++) { if (userPresets[i].id === id) p = userPresets[i]; }
            if (!p) return;
            selectedPresetId = p.id;
            setTarget(p.type, p.val, '');
            renderPresetsGrid();
            showToast("TARGET: " + $('targetLabel').innerText);
        }

        function selectDefaultPreset() {
            if (userPresets.length > 0) { selectedPresetId = userPresets[0].id; setTarget(userPresets[0].type, userPresets[0].val, ''); }
            else { selectedPresetId = null; setTarget('dist', 201, ''); }
            renderPresetsGrid();
        }

        function openCustomDistanceModal() { $('customDistanceModal').style.display = 'flex'; }
        function closeCustomDistanceModal() { $('customDistanceModal').style.display = 'none'; }
        function submitCustomDistance() {
            if (state === 'RUNNING') { showToast("STOP RUN DULU", true); return; }
            var val = parseFloat($('customMetersInput').value);
            if (isFinite(val) && val > 0) {
                selectedPresetId = null; setTarget('dist', val, 'CUSTOM'); renderPresetsGrid();
                closeCustomDistanceModal(); showToast("TARGET CUSTOM: " + fmtNum(val) + "M");
            }
        }

        function openPresetManagerModal() { renderPresetManagerList(); $('presetManagerModal').style.display = 'flex'; }
        function closePresetManagerModal() { $('presetManagerModal').style.display = 'none'; renderPresetsGrid(); }

        function renderPresetManagerList() {
            var listCont = $('presetListContainer');
            if (userPresets.length === 0) { listCont.innerHTML = '<div style="font-size:12px; color:#666; text-align:center; padding:6px;">Belum ada preset.</div>'; return; }
            var html = '';
            for (var i = 0; i < userPresets.length; i++) {
                var p = userPresets[i];
                html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; border-bottom:1px solid rgba(255,255,255,0.05);">' +
                    '<span style="font-weight:700; font-size:12px; color:var(--cyan);">' + esc(p.label) + ' (' + p.val + (p.type === 'dist' ? 'm' : ' km/h') + ')</span>' +
                    '<button onclick="deletePreset(' + p.id + ')" style="background:var(--red); color:#fff; border:none; padding:4px 8px; border-radius:6px; font-size:10px; font-weight:700; cursor:pointer;">HAPUS</button></div>';
            }
            listCont.innerHTML = html;
        }

        function addNewPreset() {
            var label = $('newPresetLabel').value.trim();
            var val = parseFloat($('newPresetVal').value);
            var type = $('newPresetType').value;
            if (!label || !isFinite(val) || val <= 0) { showToast("ISI LABEL & NILAI PRESET (HARUS > 0)", true); return; }
            userPresets.push({ id: Date.now(), type: type, val: val, label: label });
            safeSet('racebox_custom_presets', JSON.stringify(userPresets));
            $('newPresetLabel').value = ''; $('newPresetVal').value = '';
            renderPresetManagerList();
        }

        function deletePreset(id) {
            userPresets = userPresets.filter(function(p) { return p.id !== id; });
            safeSet('racebox_custom_presets', JSON.stringify(userPresets));
            if (selectedPresetId === id) selectedPresetId = null;
            renderPresetManagerList();
        }

        /* ================= SUARA ================= */
        var audioCtx = null;
        function getAudio() {
            try {
                if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            } catch (e) {}
            return audioCtx;
        }
        function playSound(freq, duration) {
            if (!soundEnabled) return;
            try {
                var ctx = getAudio(); if (!ctx) return;
                var osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime;
                osc.type = 'sine'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(t); osc.stop(t + duration + 0.02);
            } catch (e) {}
        }

        /* ================= TAB ================= */
        function switchTab(tabName, elm) {
            try { closeDrawer(); if (tabName === 'drag') refreshBikeList(); tabHooks(tabName); } catch (e) {}
            document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
            document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
            $('tab-' + tabName).classList.add('active');
            if (!elm) elm = document.querySelector('.nav-item[data-tab="' + tabName + '"]');
            if (elm) elm.classList.add('active');
            if (tabName === 'map') {
                if (!map) initMap();
                setTimeout(function() { if (map) map.invalidateSize(); }, 150);
                setTimeout(function() { if (map) map.invalidateSize(); }, 450);
            } else if (tabName === 'history') { renderHistory(); }
            else if (tabName === 'live') { setTimeout(function() { if (specMap) specMap.invalidateSize(); }, 200); }
        }

        /* ================= SPEEDOMETER ================= */
        function updateOffset(val) {
            speedOffset = parseInt(val, 10) || 0;
            $('offsetValText').innerText = (speedOffset >= 0 ? "+" : "") + speedOffset + " " + currentUnit;
        }

        function renderSpeed() {
            var disp = toDisplaySpeed(currentSpeedKmh);
            $('speedText').innerText = Math.round(disp);
            $('topSpeedText').innerText = toDisplaySpeed(topSpeedKmh).toFixed(1) + " " + currentUnit;
            var maxG = currentUnit === 'MPH' ? 150 : 240;
            var pct = Math.max(0, Math.min(disp / maxG, 1));
            $('gaugeArc').style.strokeDashoffset = (GAUGE_LEN * (1 - pct)).toFixed(1);
        }

        function resetTopSpeed() { topSpeedKmh = 0; renderSpeed(); }

        function setGpsStatus(text, color, sub, lvl) {
            var gs = $('gpsStatus'); gs.innerText = text; gs.style.color = color;
            $('gpsSub').innerText = sub || '';
            try { updateGpsChip(color, lvl); } catch (e) {}
            var b = $('gpsBars').children;
            for (var i = 0; i < b.length; i++) b[i].style.background = i < (lvl || 0) ? color : 'rgba(255,255,255,0.12)';
        }

        function initSystem() {
            getAudio();
            if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
                DeviceMotionEvent.requestPermission().then(function() { startSensors(); }).catch(function() { startSensors(); });
            } else { startSensors(); }
        }

        function requestWakeLock() {
            if (!keepAwake) return;
            try { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function(l) { wakeLock = l; }).catch(function() {}); } catch (e) {}
        }
        document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible' && sensorsOn) requestWakeLock(); });

        /* ================= PILIHAN KUSTOM (ganti <select> bawaan) ================= */
        (function enhanceSelects() {
            var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            var sheet = null;
            function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
            function build(sel) {
                try {
                    if (sel._cs) return; sel._cs = true;
                    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cs-btn';
                    var st = sel.getAttribute('style'); if (st) btn.setAttribute('style', st);
                    sel.style.display = 'none';
                    sel.parentNode.insertBefore(btn, sel.nextSibling);
                    var lb = sel.parentNode.querySelector('.setting-label');
                    var title = (lb && lb.textContent) || 'PILIH OPSI';
                    function label() { var o = sel.options[sel.selectedIndex]; btn.innerHTML = '<span>' + (o ? esc(o.text) : '') + '</span><i>⌄</i>'; }
                    Object.defineProperty(sel, 'value', { configurable: true, get: function() { return desc.get.call(this); }, set: function(v) { desc.set.call(this, v); label(); } });
                    label();
                    btn.onclick = function() {
                        closeSheet();
                        sheet = document.createElement('div'); sheet.className = 'cs-sheet';
                        var h = '<div class="cs-back"></div><div class="cs-panel"><div class="cs-grab"></div><div class="cs-title">' + esc(title) + '</div>';
                        for (var i = 0; i < sel.options.length; i++) h += '<div class="cs-opt' + (i === sel.selectedIndex ? ' on' : '') + '" data-i="' + i + '"><span>' + esc(sel.options[i].text) + '</span><b></b></div>';
                        sheet.innerHTML = h + '</div>';
                        document.body.appendChild(sheet);
                        requestAnimationFrame(function() { if (sheet) sheet.classList.add('show'); });
                        sheet.querySelector('.cs-back').onclick = closeSheet;
                        var opts = sheet.querySelectorAll('.cs-opt');
                        for (var k = 0; k < opts.length; k++) opts[k].onclick = function() {
                            var idx = +this.getAttribute('data-i');
                            if (idx !== sel.selectedIndex) { sel.selectedIndex = idx; label(); sel.dispatchEvent(new Event('change', { bubbles: true })); }
                            closeSheet();
                        };
                    };
                } catch (e) { sel.style.display = ''; }
            }
            var all = document.querySelectorAll('select.setting-input');
            for (var j = 0; j < all.length; j++) build(all[j]);
        })();

        /* ================= LEADERBOARD, CHAT, SOSMED ================= */
        var LB_CATS = [{ k: 'd201000', l: '201M' }, { k: 'd402000', l: '402M' }, { k: 'd18288', l: '60 FT' }, { k: 's60', l: '0-60' }, { k: 's100', l: '0-100' }];
        var lbCat = 'd201000', lbRef = null, chatRef = null, lastChat = 0, lastFakeAt = 0, lastFakeToast = 0;
        var LB_MIN = { d201000: 6, d402000: 6, d18288: 1, s60: 1, s100: 2 };
        function lbKey(mode, tv) { return (mode === 'dist' ? 'd' + Math.round(tv * 1000) : 's' + Math.round(tv)); }
        function postLeaderboard(elapsed, rec) {
            if (!db || !currentUser || currentUser.isAnonymous) return;
            var key = lbKey(modeType, targetValue);
            if (!LB_CATS.some(function(c) { return c.k === key; })) return;
            if (Date.now() - lastFakeAt < 5 * 60 * 1000) { showToast("LOKASI PALSU TERDETEKSI - TIDAK MASUK LEADERBOARD", true); return; }
            if (lastAcc > 25) { showToast("AKURASI GPS KURANG - TIDAK MASUK LEADERBOARD", true); return; }
            var t = +(+elapsed).toFixed(3); if (!(t > 0.3)) return;
            if (t < LB_MIN[key]) { showToast("WAKTU TIDAK WAJAR (< " + LB_MIN[key] + " DETIK) - DITOLAK", true); return; }
            var entry = { name: String(racerName || 'Racer').slice(0, 20), bike: String(rec.bike || '').slice(0, 40), time: t, speed: +runTopKmh.toFixed(1), ts: Date.now() };
            db.ref('leaderboard/' + key + '/' + currentUser.uid).transaction(function(cur) {
                if (!cur || typeof cur.time !== 'number' || t < cur.time) return entry;
            }, function(err, committed) {
                if (err) showToast("LEADERBOARD GAGAL (" + (err.code || 'error') + ")", true);
                else if (committed) showToast("REKOR BARU DI LEADERBOARD! 🏆");
            });
        }
        function lbInit() {
            var h = ''; LB_CATS.forEach(function(c) { h += '<button class="lb-chip' + (c.k === lbCat ? ' on' : '') + '" onclick="lbSelect(\'' + c.k + '\')">' + c.l + '</button>'; });
            $('lbChips').innerHTML = h;
        }
        function lbSelect(k) { lbCat = k; lbStart(); }
        function lbStop() { if (lbRef) { lbRef.off(); lbRef = null; } }
        function lbStart() {
            lbStop(); lbInit();
            var list = $('lbList');
            if (!db) { list.innerHTML = '<div class="lb-empty">Tidak terhubung ke server</div>'; return; }
            list.innerHTML = '<div class="lb-empty">Memuat...</div>';
            lbRef = db.ref('leaderboard/' + lbCat).orderByChild('time').limitToFirst(10);
            lbRef.on('value', function(snap) {
                var rows = [];
                snap.forEach(function(c) { var v = c.val(); if (v && typeof v.time === 'number') rows.push({ uid: c.key, name: v.name, bike: v.bike, time: v.time, speed: v.speed, ts: v.ts }); });
                rows.sort(function(a, b) { return a.time - b.time || (a.ts || 0) - (b.ts || 0); });
                if (!rows.length) { list.innerHTML = '<div class="lb-empty">Belum ada rekor. Jadilah yang pertama! 🏁</div>'; return; }
                var medal = ['🥇', '🥈', '🥉'], u = currentUnit === 'MPH' ? 'mph' : 'kph';
                list.innerHTML = rows.map(function(r, i) {
                    var me = currentUser && r.uid === currentUser.uid;
                    return '<div class="lb-row' + (me ? ' me' : '') + (i < 3 ? ' top' : '') + '"><div class="lb-rank">' + (medal[i] || (i + 1)) + '</div><div class="lb-who"><b>' + esc(r.name || 'Racer') + '</b><small>🏍️ ' + esc(r.bike || '-') + '</small></div><div class="lb-score"><b>' + (+r.time).toFixed(3) + 's</b><small>' + toDisplaySpeed(+r.speed || 0).toFixed(1) + ' ' + u + '</small></div></div>';
                }).join('');
            }, function(err) { list.innerHTML = '<div class="lb-empty">Gagal memuat (' + esc((err && err.code) || 'error') + ')</div>'; });
        }
        function chatStop() { if (chatRef) { chatRef.off(); chatRef = null; } }
        function chatStart() {
            chatStop();
            var el = $('chatList'), ci = $('chatInput'), guest = !currentUser || currentUser.isAnonymous;
            ci.disabled = guest; ci.placeholder = guest ? 'Login akun resmi untuk ikut chat' : 'Tulis pesan...';
            if (!db) { el.innerHTML = '<div class="lb-empty">Tidak terhubung ke server</div>'; return; }
            chatRef = db.ref('chat/global').limitToLast(60);
            chatRef.on('value', function(snap) {
                var h = '', uid = currentUser ? currentUser.uid : '';
                snap.forEach(function(c) {
                    var m = c.val(); if (!m || typeof m.text !== 'string') return;
                    var d = new Date(+m.ts || Date.now());
                    h += '<div class="msg' + (m.uid === uid ? ' mine' : '') + '"><div class="msg-n">' + esc(m.name || 'Racer') + ' · ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + '</div><div class="msg-t">' + esc(m.text) + '</div></div>';
                });
                el.innerHTML = h || '<div class="lb-empty">Belum ada pesan. Jadi yang pertama!</div>';
                el.scrollTop = el.scrollHeight;
            }, function(err) { el.innerHTML = '<div class="lb-empty">Chat gagal dimuat (' + esc((err && err.code) || 'error') + ')</div>'; });
        }
        function sendChat() {
            if (!db || !currentUser || currentUser.isAnonymous) { showToast("LOGIN AKUN RESMI UNTUK CHAT", true); return; }
            var ci = $('chatInput'), t = ci.value.trim(); if (!t) return;
            if (Date.now() - lastChat < 2500) { showToast("JANGAN SPAM, TUNGGU SEBENTAR", true); return; }
            lastChat = Date.now(); ci.value = '';
            db.ref('chat/global').push({ uid: currentUser.uid, name: String(racerName || 'Racer').slice(0, 20), text: t.slice(0, 200), ts: firebase.database.ServerValue.TIMESTAMP })
                .catch(function() { showToast("PESAN GAGAL TERKIRIM", true); });
        }
        function tabHooks(t) { if (t === 'rank') lbStart(); else lbStop(); if (t === 'chat') chatStart(); else chatStop(); }
        var SOCIALS = [
            { role: 'OWNER', plat: 'INSTAGRAM', handle: '@khalilhmmmmyh', url: 'https://www.instagram.com/khalilhmmmmyh', av: 'data:image/jpeg;base64,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', c: '#ff4fa3' },
            { role: 'OWNER', plat: 'TIKTOK', handle: '@wongpolosbiasa', url: 'https://www.tiktok.com/@wongpolosbiasa', av: 'data:image/jpeg;base64,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', c: '#00F2FE' },
            { role: 'SUPPORT', plat: 'TIKTOK', handle: '@ambaturace.gank', url: 'https://www.tiktok.com/@ambaturace.gank', av: 'data:image/jpeg;base64,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', c: '#00FF87' }
        ];
        (function renderSocials() {
            try {
                $('socialList').innerHTML = SOCIALS.map(function(x) {
                    return '<a class="soc-card" style="--c:' + x.c + ';" href="' + x.url + '" target="_blank" rel="noopener"><div class="soc-av"><span>' + esc(x.handle.charAt(1).toUpperCase()) + '</span><img src="' + x.av + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()"></div><div class="soc-info"><b>' + esc(x.handle) + '</b><small>' + x.plat + '</small></div><div class="soc-role">' + x.role + '</div></a>';
                }).join('');
                lbInit();
            } catch (e) {}
        })();

        /* ================= MENU KIRI, STATUS BAR, NAMA MOTOR ================= */
        function openDrawer() { var d = $('navDrawer'); if (d) { d.classList.add('open'); $('drawerBackdrop').classList.add('show'); } }
        function closeDrawer() { var d = $('navDrawer'); if (d) { d.classList.remove('open'); $('drawerBackdrop').classList.remove('show'); } }
        function toggleDrawer() { var d = $('navDrawer'); if (d && d.classList.contains('open')) closeDrawer(); else openDrawer(); }
        function updateGpsChip(color, lvl) {
            var d = $('ssGpsDot'), v = $('ssGpsVal'); if (!d || !v) return;
            if (!sensorsOn || !lvl) { d.style.background = 'var(--dim)'; d.style.color = 'var(--dim)'; v.style.color = ''; v.textContent = 'GPS OFF'; return; }
            d.style.background = color; d.style.color = color; v.style.color = color;
            v.textContent = 'GPS ' + (gpsHz ? gpsHz.toFixed(1) + 'Hz' : '...') + (lastAcc ? ' ±' + Math.round(lastAcc) + 'm' : '');
        }
        function saveBikeName() { safeSet('racebox_bike', ($('bikeName').value || '').slice(0, 40)); }
        function refreshBikeList() {
            var dl = $('bikeList'); if (!dl) return;
            var logs = []; try { logs = JSON.parse(localStorage.getItem('racebox_logs') || '[]'); } catch (e) {}
            var seen = {}, h = '';
            logs.forEach(function(l) { if (l && l.bike && !seen[l.bike]) { seen[l.bike] = 1; h += '<option value="' + esc(l.bike) + '">'; } });
            dl.innerHTML = h;
        }
        (function initStatusUI() {
            try {
                var clock = $('ssClock');
                var tick = function() { var d = new Date(); clock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
                tick(); setInterval(function() { if (!document.hidden) tick(); }, 1000);
                var bn = $('bikeName'); if (bn) bn.value = localStorage.getItem('racebox_bike') || '';
                if (navigator.getBattery) {
                    navigator.getBattery().then(function(b) {
                        var up = function() {
                            var pc = Math.round(b.level * 100), low = pc <= 20 && !b.charging;
                            $('ssBattVal').textContent = pc + '%'; $('ssBattVal').style.color = low ? 'var(--red)' : '';
                            $('ssBattIcon').textContent = b.charging ? '⚡' : (low ? '🪫' : '🔋');
                        };
                        up(); b.addEventListener('levelchange', up); b.addEventListener('chargingchange', up);
                    }).catch(function() { $('ssBattVal').textContent = 'N/A'; });
                } else { $('ssBattVal').textContent = 'N/A'; }
            } catch (e) {}
        })();

        /* ================= IZIN (APK / CAPACITOR) ================= */
        var _plugs = {};
        function plug(n) {
            if (_plugs[n]) return _plugs[n];
            var C = window.Capacitor, p = null;
            if (C && C.Plugins && C.Plugins[n]) p = C.Plugins[n];
            else if (C && typeof C.registerPlugin === 'function') p = C.registerPlugin(n);
            if (!p) throw { message: 'Plugin ' + n + ' tidak ditemukan (jalankan npx cap sync android lalu build ulang)' };
            return (_plugs[n] = p);
        }
        function isNativeApp() { var c = window.Capacitor; return !!(c && c.isNativePlatform && c.isNativePlatform()); }
        function withTimeout(p, ms, tag) {
            return new Promise(function(res, rej) {
                var t = setTimeout(function() { rej({ code: 'TIMEOUT', message: tag + ' tidak merespons (plugin belum terpasang? jalankan npx cap sync lalu build ulang)' }); }, ms);
                Promise.resolve(p).then(function(v) { clearTimeout(t); res(v); }, function(e) { clearTimeout(t); rej(e); });
            });
        }
        function geoReq() {
            return Promise.resolve().then(function() {
                var Geo = plug('Geolocation');
                return withTimeout(Geo.checkPermissions(), 3000, 'Geolocation').then(function(r) {
                    if (r.location === 'granted' || r.coarseLocation === 'granted') return 'granted';
                    return withTimeout(Geo.requestPermissions({ permissions: ['location'] }), 45000, 'Dialog lokasi').then(function(r2) {
                        return (r2.location === 'granted' || r2.coarseLocation === 'granted') ? 'granted' : 'denied';
                    });
                });
            }).catch(function() {
                // Cadangan: pancing dialog izin lewat WebView
                return new Promise(function(res) {
                    if (!navigator.geolocation) { res('na'); return; }
                    navigator.geolocation.getCurrentPosition(function() { res('granted'); }, function(er) { res(er.code === 1 ? 'denied' : 'granted'); }, { timeout: 15000, enableHighAccuracy: true });
                });
            });
        }
        function notifReq() {
            return Promise.resolve().then(function() {
                var LN = plug('LocalNotifications');
                return withTimeout(LN.checkPermissions(), 3000, 'LocalNotifications').then(function(r) {
                    if (r.display === 'granted') return 'granted';
                    return withTimeout(LN.requestPermissions(), 45000, 'Dialog notifikasi').then(function(r2) { return r2.display === 'granted' ? 'granted' : 'denied'; });
                });
            }).catch(function() { return 'na'; });
        }
        function askAllPermissions(progress) {
            progress = progress || function() {};
            var out = { loc: 'na', notif: 'na' };
            progress("Langkah 1/2: izin lokasi");
            return geoReq().then(function(r) { out.loc = r; progress("Langkah 2/2: izin notifikasi"); return notifReq(); })
                .then(function(r) { out.notif = r; return out; });
        }
        function openAppSettings() { try { plug('BackgroundGeolocation').openSettings(); } catch (e) { showToast("BUKA: PENGATURAN HP > APLIKASI > RACEBOX > IZIN", true); } }

        function runPermFlow() {
            showToast("MEMINTA IZIN...");
            askAllPermissions().then(function(p) {
                if (p.loc === 'denied') {
                    sysModal({ icon: '📍', title: 'IZIN LOKASI DITOLAK', msg: 'Tanpa lokasi, speedo & drag tidak bisa jalan. Buka pengaturan lalu izinkan lokasi.',
                        buttons: [{ text: 'NANTI' }, { text: 'BUKA PENGATURAN', cls: 'sys-primary', fn: openAppSettings }] });
                    return;
                }
                if (p.notif !== 'granted') {
                    sysModal({ icon: '🔔', title: 'NOTIFIKASI BELUM DIIZINKAN', msg: 'Notifikasi diperlukan agar GPS tetap aktif di background. Buka pengaturan, pilih <b style="color:#fff;">Notifikasi</b>, lalu aktifkan <b style="color:#fff;">Izinkan notifikasi</b>.',
                        buttons: [{ text: 'NANTI' }, { text: 'BUKA PENGATURAN', cls: 'sys-primary', fn: openAppSettings }] });
                    return;
                }
                safeSet('racebox_perm_ok', '1');
                var nmsg = p.notif === 'denied' ? '<br><br>⚠️ Notifikasi ditolak, jadi indikator "RaceBox aktif" tidak muncul. Aktifkan lewat pengaturan.' : '';
                sysModal({ icon: '✅', title: 'IZIN AKTIF', msg: 'Agar GPS tetap jalan saat layar mati atau aplikasi di background, ubah izin lokasi ke <b style="color:#fff;">"Selalu"</b> di pengaturan.' + nmsg,
                    buttons: [{ text: 'NANTI' }, { text: 'BUKA PENGATURAN', cls: 'sys-primary', fn: openAppSettings }] });
            });
        }
        function permOnboarding(force) {
            if (!isNativeApp()) return;
            var chk = function(fn, key) {
                return Promise.resolve().then(fn).then(function(r) { return withTimeout(r, 3000, 'x'); }).then(function(r) { return r[key] === 'granted' || r.coarseLocation === 'granted'; }).catch(function() { return false; });
            };
            Promise.all([
                chk(function() { return plug('Geolocation').checkPermissions(); }, 'location'),
                chk(function() { return plug('LocalNotifications').checkPermissions(); }, 'display')
            ]).then(function(a) {
                if (!force && a[0] && a[1]) return;
                sysModal({ icon: '🔐', title: 'IZINKAN AKSES RACEBOX',
                    msg: 'Supaya speedo & drag timer berfungsi, RaceBox butuh:<br><br>📍 <b style="color:#fff;">Lokasi</b> untuk GPS<br>🔔 <b style="color:#fff;">Notifikasi</b> agar GPS tetap aktif di background<br><br>Pilih <b style="color:var(--cyan);">"Izinkan"</b> pada setiap pertanyaan yang muncul.',
                    buttons: [{ text: 'NANTI' }, { text: 'IZINKAN SEMUA', cls: 'sys-primary', fn: runPermFlow }] });
            });
        }
        function startupNotice() {
            var off = !navigator.onLine;
            sysModal({ icon: off ? '📵' : '📶', title: off ? 'KAMU SEDANG OFFLINE' : 'WAJIB TERHUBUNG INTERNET',
                msg: (off ? 'Nyalakan <b style="color:#fff;">WiFi</b> atau <b style="color:#fff;">data seluler</b> dulu. ' : 'Gunakan <b style="color:#fff;">WiFi</b> atau <b style="color:#fff;">data seluler</b>. ') + 'RaceBox butuh internet untuk login, leaderboard, chat, dan live spectator. GPS tetap jalan tanpa internet, tapi data tidak tersinkron.',
                buttons: [{ text: 'MENGERTI', cls: 'sys-primary', fn: function() { try { permOnboarding(false); } catch (e) {} } }] });
        }
        window.addEventListener('load', function() { setTimeout(startupNotice, 400); });
        window.addEventListener('offline', function() { showToast("KAMU OFFLINE - NYALAKAN WIFI / DATA", true); });

        function startNativeWatcher() {
            var BG = plug('BackgroundGeolocation');
            return Promise.resolve(BG.addWatcher({
                backgroundTitle: "RaceBox aktif",
                backgroundMessage: "GPS dipakai untuk speedo & drag",
                requestPermissions: true, stale: false, distanceFilter: 0
            }, function(loc, err) {
                if (!loc && !err) return;
                if (err) {
                    if (err.code === 'NOT_AUTHORIZED') {
                        sysModal({ icon: '📍', title: 'IZIN LOKASI DIPERLUKAN', msg: 'Buka pengaturan lalu pilih izin lokasi <b style="color:#fff;">"Selalu"</b>.',
                            buttons: [{ text: 'NANTI' }, { text: 'BUKA PENGATURAN', cls: 'sys-primary', fn: openAppSettings }] });
                    }
                    onGpsError({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2 }); return;
                }
                if (loc.simulated) {
                    lastFakeAt = Date.now();
                    if (Date.now() - lastFakeToast > 30000) { lastFakeToast = Date.now(); showToast("LOKASI PALSU (FAKE GPS) TERDETEKSI", true); }
                }
                updateGPS({ coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed }, timestamp: loc.time });
            })).then(function(id) { bgWatcherId = id; });
        }

        function startSensors() {
            if (sensorsOn) { showToast("SENSOR SUDAH AKTIF"); return; }
            var native = isNativeApp();
            if (!native && !navigator.geolocation) { setGpsStatus("GPS TIDAK DIDUKUNG BROWSER", "#FF2A55", "", 0); return; }
            sensorsOn = true; lastFixWall = 0;

            var done = function() {
                window.addEventListener('devicemotion', handleMotion);
                requestWakeLock(); initMap();
                $('sensorBtn').innerText = "SENSOR AKTIF";
                setGpsStatus("MENGIKAT SATELIT GPS...", "#FFD000", "Menunggu sinyal", 1);
                setTimeout(function() {
                    if (sensorsOn && !lastFixWall) setGpsStatus("BELUM ADA SINYAL", "#FFD000", "Pastikan GPS HP aktif, izin lokasi 'Selalu', dan area terbuka", 1);
                }, 12000);
            };
            var fail = function(e) {
                sensorsOn = false;
                $('sensorBtn').innerText = "AKTIFKAN GPS & SENSOR";
                if (e && e.code === 1) onGpsError({ code: 1 });
                else setGpsStatus("GAGAL AKTIF", "#FF2A55", String((e && e.message) || e || "plugin belum terpasang"), 0);
            };

            if (native) {
                setGpsStatus("MEMINTA IZIN...", "#FFD000", "Izinkan lokasi & notifikasi", 1);
                askAllPermissions(function(step) { setGpsStatus("MEMINTA IZIN...", "#FFD000", step, 1); }).then(function(p) {
                    if (p.loc === 'denied') throw { code: 1 };
                    if (p.notif !== 'granted') showToast("NOTIFIKASI BELUM DIIZINKAN - AKTIFKAN DI PENGATURAN", true);
                    setGpsStatus("MENYALAKAN GPS...", "#FFD000", "Mengaktifkan layanan background", 1);
                    startNativeWatcher().catch(fail);
                    done();
                }).catch(fail);
            } else {
                watchId = navigator.geolocation.watchPosition(updateGPS, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
                done();
            }
        }

        function onGpsError(err) {
            var msgs = { 1: "IZIN LOKASI DITOLAK", 2: "POSISI TIDAK TERSEDIA", 3: "GPS TIMEOUT - CARI SINYAL..." };
            setGpsStatus(msgs[err.code] || "GPS ERROR", "#FF2A55", err.code === 1 ? "Izinkan lokasi \"Selalu\" di pengaturan HP" : "Pindah ke area terbuka", 0);
            if (err.code === 1) {
                if (watchId !== null) navigator.geolocation.clearWatch(watchId);
                if (bgWatcherId !== null) { try { Capacitor.registerPlugin('BackgroundGeolocation').removeWatcher({ id: bgWatcherId }); } catch (e) {} bgWatcherId = null; }
                watchId = null; sensorsOn = false;
                window.removeEventListener('devicemotion', handleMotion);
                $('sensorBtn').innerText = "AKTIFKAN GPS & SENSOR";
            }
        }

        function calcDistance(lat1, lon1, lat2, lon2) {
            if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
            var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
            var a = Math.pow(Math.sin(dp / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
            return 6371e3 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        }

        function updateGPS(pos) {
            var c = pos.coords;
            var t = pos.timestamp;
            if (!t || Math.abs(Date.now() - t) > 10000) t = Date.now();   // jam GPS tidak cocok dengan jam HP -> pakai jam HP
            var acc = c.accuracy || 0;
            lastAcc = acc;
            var nowW = Date.now();
            if (lastFixWall) { var w = nowW - lastFixWall; if (w > 50 && w < 5000) gpsHz = gpsHz ? 0.7 * gpsHz + 0.3 * (1000 / w) : 1000 / w; }
            lastFixWall = nowW;

            // Fix yang sangat buruk dibuang supaya angka tidak loncat (kecepatan Doppler tetap dipakai kalau akurasi <= 150 m)
            if (acc > 150) { setGpsStatus("GPS SANGAT LEMAH (±" + Math.round(acc) + " m)", "#FF2A55"); return; }
            currentLat = c.latitude; currentLng = c.longitude;

            var speedMs = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) ? c.speed : null;
            if (speedMs === null && lastFix) {
                var dtS = (t - lastFix.t) / 1000;
                if (dtS > 0.2 && dtS < 5 && acc <= 50) {
                    var d = calcDistance(lastFix.lat, lastFix.lng, c.latitude, c.longitude);
                    speedMs = d > Math.max(2, acc * 0.5) ? d / dtS : 0;
                }
            }
            if (speedMs === null) speedMs = 0;
            // Peredam noise GPS: saat diam, GPS sering melaporkan 0.3-1 m/s palsu -> dianggap 0 supaya jarak tidak jalan sendiri
            var floorMs = 0.9 + Math.min(acc, 50) * 0.02;
            if (speedMs < floorMs) speedMs = 0;
            var rawKmh = speedMs * 3.6;

            var alpha = (state === 'RUNNING' || state === 'ARMED') ? 1.0 : 0.4;
            smoothedKmh = alpha * rawKmh + (1 - alpha) * smoothedKmh;
            if (rawKmh < 0.5 && smoothedKmh < 1.5) smoothedKmh = 0;

            currentSpeedKmh = smoothedKmh < 2.0 ? 0 : Math.max(0, smoothedKmh + offsetKmh());
            if (currentSpeedKmh > topSpeedKmh) topSpeedKmh = currentSpeedKmh;
            renderSpeed();

            if (acc <= 25) goodFixes++; else goodFixes = 0;
            var qa = Math.round(acc), hz = gpsHz ? gpsHz.toFixed(1) + ' Hz' : '';
            if (goodFixes < 3 && acc <= 25) setGpsStatus("MENGUNCI SATELIT...", "#FFD000", "Akurasi ±" + qa + " m · tunggu sebentar", 2);
            else if (acc <= 5) setGpsStatus("GPS TERKUNCI", "#00FF87", "Sangat akurat · ±" + qa + " m · " + hz, 4);
            else if (acc <= 12) setGpsStatus("GPS TERKUNCI", "#00FF87", "Akurat · ±" + qa + " m · " + hz, 3);
            else if (acc <= 25) setGpsStatus("GPS CUKUP", "#FFD000", "Cukup · ±" + qa + " m · cari area terbuka", 2);
            else setGpsStatus("GPS LEMAH", "#FF9100", "±" + qa + " m · hindari bangunan/atap", 1);

            if (map) {
                if (!userMarker) {
                    userMarker = L.circleMarker([currentLat, currentLng], { color: '#00F2FE', radius: 7, fillColor: '#00F2FE', fillOpacity: 0.8 }).addTo(map);
                    map.setView([currentLat, currentLng], 17);
                } else { userMarker.setLatLng([currentLat, currentLng]); }
            }

            var prev = lastFix;
            var dtMs = prev ? (t - prev.t) : 0;
            var validDt = !!prev && dtMs > 0 && dtMs < 5000;

            if (state === 'ARMED') {
                if (rawKmh < AUTO_START_KMH) {
                    standFix = { t: t };
                } else if ($('autoStartToggle').checked) {
                    var t0, d0;
                    if (standFix && (t - standFix.t) > 0 && (t - standFix.t) < 3000) { t0 = standFix.t; d0 = (speedMs / 2) * ((t - t0) / 1000); }
                    else { t0 = t - 500; d0 = (speedMs / 2) * 0.5; }
                    startRun(t0, d0, 'gps');
                    launchInfo = { t0Old: t0, d0Old: d0 };
                }
            } else if (state === 'RUNNING') {
                if (launchInfo && validDt) {
                    var acc2 = (speedMs - prev.speedMs) / (dtMs / 1000);
                    if (acc2 > 0.3 && prev.speedMs > 0) {
                        var t0n = prev.t - (prev.speedMs / acc2) * 1000;
                        t0n = Math.max(launchInfo.t0Old, Math.min(prev.t, t0n));
                        var d0n = (prev.speedMs / 2) * ((prev.t - t0n) / 1000);
                        runStartEpoch = t0n;
                        highResStartTime = performance.now() - (Date.now() - runStartEpoch);
                        accumulatedDistance += d0n - launchInfo.d0Old;
                    }
                    launchInfo = null;
                }
                if (validDt) {
                    var inc = ((prev.speedMs + speedMs) / 2) * (dtMs / 1000);
                    captureSplits(prev, inc, dtMs);
                    if (modeType === 'dist') {
                        if (inc > 0 && accumulatedDistance + inc >= targetValue) {
                            var frac = (targetValue - accumulatedDistance) / inc;
                            accumulatedDistance = targetValue;
                            finishRun(prev.t + frac * dtMs, prev.dispKmh + frac * (currentSpeedKmh - prev.dispKmh));
                        } else { accumulatedDistance += inc; }
                    } else {
                        accumulatedDistance += inc;
                        if (currentSpeedKmh >= targetValue) {
                            var span = currentSpeedKmh - prev.dispKmh;
                            var f2 = span > 0 ? (targetValue - prev.dispKmh) / span : 1;
                            finishRun(prev.t + Math.max(0, Math.min(1, f2)) * dtMs, targetValue);
                        }
                    }
                } else if (modeType === 'speed' && currentSpeedKmh >= targetValue) {
                    finishRun(t);
                }
                if (state === 'RUNNING' && currentSpeedKmh > runTopKmh) runTopKmh = currentSpeedKmh;
                if (state === 'RUNNING') pushSample(t);
                updateProgress();
            }

            lastFix = { lat: c.latitude, lng: c.longitude, t: t, speedMs: speedMs, dispKmh: currentSpeedKmh };
            broadcastState(false);
        }

        setInterval(function() {
            if (!sensorsOn || !lastFixWall) return;
            var age = Date.now() - lastFixWall;
            if (age > 3000) {
                setGpsStatus("SINYAL GPS HILANG", "#FF2A55", "Tidak ada update " + Math.round(age / 1000) + " detik", 0);
                if (state !== 'RUNNING' && currentSpeedKmh > 0) { smoothedKmh = 0; currentSpeedKmh = 0; renderSpeed(); }
            }
        }, 1000);

        /* ================= AUTO-START SENSOR GERAK ================= */
        function handleMotion(ev) {
            if (state !== 'ARMED' || !$('autoStartToggle').checked) return;
            if (Date.now() - armedAt < 2000) return;
            var a = ev.acceleration, mag;
            if (a && a.x !== null && a.x !== undefined) {
                mag = Math.sqrt(Math.pow(a.x || 0, 2) + Math.pow(a.y || 0, 2) + Math.pow(a.z || 0, 2));
            } else {
                var g = ev.accelerationIncludingGravity; if (!g) return;
                var m = Math.sqrt(Math.pow(g.x || 0, 2) + Math.pow(g.y || 0, 2) + Math.pow(g.z || 0, 2));
                if (accelBase === null) accelBase = m;
                accelBase = 0.95 * accelBase + 0.05 * m;
                mag = Math.abs(m - accelBase);
            }
            // Harus akselerasi KUAT dan TERUS-MENERUS >= 0.5 detik (guncangan/gerak tangan sebentar diabaikan)
            motionSm = 0.75 * motionSm + 0.25 * mag;
            if (motionSm > AUTO_SENS[autoSensIdx]) {
                if (!motionHits) motionHits = Date.now();
                else if (Date.now() - motionHits >= 500) { motionHits = 0; motionSm = 0; startRun(Date.now(), 0, 'motion'); }
            } else { motionHits = 0; }
        }

        /* ================= ALUR RUN ================= */
        function resetLights() {
            $('lightRed').className = "tree-light red";
            $('lightYellow').className = "tree-light yellow";
            $('lightGreen').className = "tree-light green";
        }

        function handleMainButton() {
            getAudio();
            if (state === 'IDLE' || state === 'FINISHED') { armSystemSequence(); } else { stopRun(); }
        }

        function armSystemSequence() {
            if (!sensorsOn) { showToast("AKTIFKAN GPS DULU DI TAB SPEEDO", true); return; }
            var myToken = ++armToken;
            state = 'ARMED'; accumulatedDistance = 0; armedAt = Date.now(); motionHits = 0; accelBase = null; motionSm = 0; launchInfo = null; lastFinalTime = null;
            standFix = (lastFix && lastFix.speedMs * 3.6 < AUTO_START_KMH) ? { t: lastFix.t } : null;
            $('timerText').innerText = "0.00";
            $('timerText').className = "timer-val digital-font";
            resetLights();
            updateUI();

            var lightR = $('lightRed'), lightY = $('lightYellow'), lightG = $('lightGreen');
            lightR.className = "tree-light red active"; playSound(440, 0.15);
            setTimeout(function() {
                if (state !== 'ARMED' || myToken !== armToken) return;
                lightR.className = "tree-light red"; lightY.className = "tree-light yellow active"; playSound(550, 0.15);
            }, 800);
            setTimeout(function() {
                if (state !== 'ARMED' || myToken !== armToken) return;
                lightY.className = "tree-light yellow"; lightG.className = "tree-light green active"; playSound(880, 0.3);
                if (!$('autoStartToggle').checked) startRun(Date.now(), 0, 'manual');
            }, 1600);
        }

        function buildMarks() {
            var base = modeType === 'dist' ? [20, 100, 201, 402, 804] : [20, 40, 60, 80, 100, 120, 150, 200];
            return base.filter(function(m) { return m < targetValue - 0.01; });
        }
        function pushSample(t) {
            var el = Math.max(0, (t - runStartEpoch) / 1000);
            var last = runSamples[runSamples.length - 1];
            if (last && el <= last[0]) return;
            runSamples.push([+el.toFixed(3), +currentSpeedKmh.toFixed(2), +accumulatedDistance.toFixed(2)]);
        }
        function captureSplits(prev, inc, dtMs) {
            while (runMarks.length) {
                var m = runMarks[0], frac = -1;
                if (modeType === 'dist') {
                    if (accumulatedDistance >= m) frac = 0;
                    else if (inc > 0 && accumulatedDistance + inc >= m) frac = (m - accumulatedDistance) / inc;
                } else {
                    var span = currentSpeedKmh - prev.dispKmh;
                    if (prev.dispKmh >= m) frac = 0;
                    else if (currentSpeedKmh >= m && span > 0) frac = (m - prev.dispKmh) / span;
                }
                if (frac < 0) break;
                frac = Math.max(0, Math.min(1, frac));
                var el = Math.max(0, (prev.t + frac * dtMs - runStartEpoch) / 1000);
                var ls = runSplits[runSplits.length - 1];
                if (ls && el < ls.t) el = ls.t;
                runSplits.push({ m: m, t: +el.toFixed(3), v: +(prev.dispKmh + frac * (currentSpeedKmh - prev.dispKmh)).toFixed(2) });
                runMarks.shift();
            }
        }

        function startRun(startEpoch, initDist, source) {
            if (state !== 'ARMED') return;
            state = 'RUNNING';
            runSource = source || 'gps';
            runStartEpoch = startEpoch || Date.now();
            highResStartTime = performance.now() - (Date.now() - runStartEpoch);
            accumulatedDistance = initDist || 0;
            runTopKmh = currentSpeedKmh;
            runSamples = [[0, 0, +(initDist || 0).toFixed(2)]]; runSplits = []; runMarks = buildMarks();
            $('lightRed').className = "tree-light red";
            $('lightYellow').className = "tree-light yellow";
            $('lightGreen').className = "tree-light green active";
            $('timerText').className = "timer-val digital-font neon-yellow";
            cancelAnimationFrame(animFrameReq);
            animFrameReq = requestAnimationFrame(updateTimerLoop);
            updateUI();
        }

        var _lastTimerTxt = '', _timerEl = null;
        function updateTimerLoop() {
            if (state !== 'RUNNING') return;
            var elapsed = (performance.now() - highResStartTime) / 1000;
            var tt = elapsed.toFixed(2);
            if (tt !== _lastTimerTxt) { _lastTimerTxt = tt; (_timerEl || (_timerEl = $('timerText'))).innerText = tt; }
            if (runSource !== 'manual' && elapsed > 3 && accumulatedDistance < 3 && currentSpeedKmh < AUTO_START_KMH) {
                state = 'ARMED'; armedAt = Date.now(); motionHits = 0; accelBase = null; standFix = null;
                $('timerText').innerText = "0.00"; $('timerText').className = "timer-val digital-font";
                resetLights(); updateUI(); showToast("START PALSU DIBATALKAN - ARMED LAGI", true);
                return;
            }
            updateProgress();
            animFrameReq = requestAnimationFrame(updateTimerLoop);
        }

        function finishRun(endEpoch, endSpeedKmh) {
            if (state !== 'RUNNING') return;
            var spdAtEnd = (typeof endSpeedKmh === 'number') ? endSpeedKmh : currentSpeedKmh;
            if (spdAtEnd > runTopKmh) runTopKmh = spdAtEnd;
            cancelAnimationFrame(animFrameReq); launchInfo = null;
            var nowElapsed = (Date.now() - runStartEpoch) / 1000;
            var elapsed = ((endEpoch || Date.now()) - runStartEpoch) / 1000;
            if (!isFinite(elapsed) || elapsed <= 0 || elapsed > nowElapsed + 0.05) elapsed = Math.max(nowElapsed, 0.01);

            while (runSamples.length > 1 && runSamples[runSamples.length - 1][0] >= elapsed) runSamples.pop();
            runSamples.push([+elapsed.toFixed(3), +spdAtEnd.toFixed(2), +accumulatedDistance.toFixed(2)]);
            var lsp = runSplits[runSplits.length - 1];
            runSplits.push({ m: targetValue, t: +(lsp && elapsed < lsp.t ? lsp.t : elapsed).toFixed(3), v: +spdAtEnd.toFixed(2) });
            state = 'FINISHED'; lastFinalTime = elapsed;
            $('timerText').innerText = elapsed.toFixed(2);
            $('timerText').className = "timer-val digital-font neon-green";
            resetLights(); $('lightGreen').className = "tree-light green";
            playSound(1200, 0.4);
            showToast("FINISH! " + elapsed.toFixed(2) + "s");
            saveToHistory(elapsed);
            updateUI();
        }

        function stopRun() {
            state = 'IDLE'; armToken++; launchInfo = null; lastFinalTime = null;
            cancelAnimationFrame(animFrameReq);
            accumulatedDistance = 0;
            resetLights();
            $('timerText').className = "timer-val digital-font";
            updateUI();
        }

        function updateProgress() {
            var pct = 0, txt;
            if (modeType === 'dist') {
                var live = accumulatedDistance;
                if (state === 'RUNNING' && lastFix) {
                    var age = (Date.now() - lastFixWall) / 1000;
                    if (age < 2.5) live += lastFix.speedMs * age;
                }
                live = Math.min(live, targetValue);
                txt = live.toFixed(1) + " / " + targetValue.toFixed(1) + " m";
                pct = (live / targetValue) * 100;
            } else {
                txt = "TARGET: 0-" + fmtNum(toDisplaySpeed(targetValue)) + " " + currentUnit;
                pct = (currentSpeedKmh / targetValue) * 100;
            }
            $('distText').innerText = txt;
            $('progressBar').style.width = Math.max(0, Math.min(pct, 100)) + "%";
        }

        function updateUI() {
            var btn = $('mainBtn'), alertBox = $('statusAlert');
            updateProgress();
            btn.style.color = "#000"; btn.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
            if (state === 'ARMED') {
                btn.innerText = "ARMED (SIAP LAUNCH)"; btn.style.background = "linear-gradient(135deg, #FFD000, #FF9100)";
                alertBox.innerText = "SISTEM ARMED - MENUNGGU GAS!"; alertBox.style.color = "#FFD000";
            } else if (state === 'RUNNING') {
                btn.innerText = "STOP RUN"; btn.style.background = "linear-gradient(135deg, #FF2A55, #D50032)"; btn.style.color = "#fff";
                btn.style.boxShadow = "0 8px 28px rgba(255,42,85,0.35)";
                alertBox.innerText = "MELAJU DALAM LINTASAN!"; alertBox.style.color = "#FF2A55";
            } else if (state === 'FINISHED') {
                btn.innerText = "RESET / READY LAGI"; btn.style.background = "linear-gradient(135deg, #00FF87, #00B956)";
                alertBox.innerText = "FINISH! WAKTU TERSIMPAN"; alertBox.style.color = "#00FF87";
            } else {
                btn.innerText = "READY / START"; btn.style.background = "#ffffff";
                alertBox.innerText = "TEKAN READY UNTUK MULAI"; alertBox.style.color = "#666666";
            }
            broadcastState(true);
        }

        /* ================= LIVE STREAM ================= */
        var activeHostSession = null, hostHeartbeat = null, lastBroadcast = 0;
        var activeSpectatorRef = null, specData = null, specTicker = null, specMap = null, specMarker = null;

        function sanitizeRoomId(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24); }

        function hashPw(pw) {
            if (!pw) return Promise.resolve('');
            function fallback() { var h = 5381; for (var i = 0; i < pw.length; i++) h = ((h << 5) + h + pw.charCodeAt(i)) | 0; return 'f' + (h >>> 0).toString(16); }
            try {
                if (window.crypto && crypto.subtle && window.TextEncoder) {
                    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('rbx:' + pw)).then(function(buf) {
                        return Array.prototype.map.call(new Uint8Array(buf), function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
                    }).catch(fallback);
                }
            } catch (e) {}
            return Promise.resolve(fallback());
        }

        function setHostUi(on) {
            $('hostBadge').className = 'live-badge' + (on ? '' : ' off');
            $('hostBadgeText').innerText = on ? 'ON AIR' : 'OFFLINE';
            var b = $('hostBtn');
            b.innerText = on ? 'STOP BROADCAST' : 'MULAI HOST BROADCAST';
            b.style.background = on ? '#1c2230' : 'var(--red)';
            $('hostSessionId').disabled = on; $('hostPassword').disabled = on;
        }

        function toggleHostBroadcast() { if (activeHostSession) stopHostBroadcast(false); else startHostBroadcast(); }

        function startHostBroadcast() {
            if (!db) { showToast("OFFLINE - FIREBASE BELUM SIAP", true); return; }
            if (!currentUser || currentUser.isAnonymous) { showToast("AKUN TAMU TIDAK BISA JADI HOST", true); return; }
            if (!sensorsOn) { showToast("AKTIFKAN GPS DULU DI TAB SPEEDO", true); return; }
            var id = sanitizeRoomId($('hostSessionId').value);
            if (!id) { showToast("ISI SESSION ID (HURUF/ANGKA)", true); return; }
            $('hostSessionId').value = id;
            var btn = $('hostBtn'); btn.disabled = true;

            hashPw($('hostPassword').value).then(function(h) {
                var ref = db.ref('streams/' + id);
                return ref.once('value').then(function(snap) {
                    var v = snap.val(), serverNow = Date.now() + serverOffset;
                    if (v && v.meta && v.meta.owner !== currentUser.uid && v.data && (serverNow - (v.data.updatedAt || 0)) < 15000) {
                        showToast("ROOM SEDANG DIPAKAI HOST LAIN", true); return;
                    }
                    return ref.set({ meta: { owner: currentUser.uid, pw: h, name: racerName } }).then(function() {
                        ref.onDisconnect().remove();
                        activeHostSession = id; safeSet('racebox_host_id', id);
                        setHostUi(true);
                        clearInterval(hostHeartbeat);
                        hostHeartbeat = setInterval(function() { broadcastState(true); }, 2000);
                        broadcastState(true);
                        showToast("BROADCAST LIVE: " + id);
                    });
                });
            }).catch(function() { showToast("GAGAL MEMULAI BROADCAST", true); })
              .then(function() { btn.disabled = false; });
        }

        function stopHostBroadcast(silent) {
            clearInterval(hostHeartbeat); hostHeartbeat = null;
            var id = activeHostSession; activeHostSession = null;
            if (id && db) { try { var r = db.ref('streams/' + id); r.onDisconnect().cancel(); r.remove(); } catch (e) {} }
            if ($('hostBtn')) setHostUi(false);
            if (id && !silent) showToast("BROADCAST DIHENTIKAN");
        }

        function broadcastState(force) {
            if (!activeHostSession || !db) return;
            var now = Date.now();
            if (!force && now - lastBroadcast < 700) return;
            lastBroadcast = now;
            var share = $('hostShareLoc').checked;
            var liveDist = accumulatedDistance;
            db.ref('streams/' + activeHostSession + '/data').set({
                name: racerName,
                state: state,
                speedKmh: Math.round(currentSpeedKmh * 10) / 10,
                topKmh: Math.round((state === 'IDLE' ? topSpeedKmh : Math.max(runTopKmh, 0)) * 10) / 10,
                mode: modeType,
                target: targetValue,
                dist: Math.round(liveDist * 10) / 10,
                startEpoch: state === 'RUNNING' ? Math.round(runStartEpoch + serverOffset) : null,
                finalTime: state === 'FINISHED' ? lastFinalTime : null,
                lat: share && currentLat ? currentLat : null,
                lng: share && currentLng ? currentLng : null,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            }).catch(function() {});
        }

        function joinSpectatorRoom() {
            if (!db) { showToast("OFFLINE - FIREBASE BELUM SIAP", true); return; }
            var id = sanitizeRoomId($('joinSessionId').value);
            if (!id) { showToast("ISI SESSION ID TEMAN", true); return; }
            $('joinSessionId').value = id;
            var btn = $('joinBtn'); btn.disabled = true;
            leaveSpectatorRoom(true);

            hashPw($('joinPassword').value).then(function(h) {
                return db.ref('streams/' + id + '/meta').once('value').then(function(snap) {
                    var m = snap.val();
                    if (!m) { showToast("ROOM TIDAK DITEMUKAN / OFFLINE", true); return; }
                    if (m.pw && m.pw !== h) { showToast("PASSWORD ROOM SALAH", true); return; }
                    safeSet('racebox_join_id', id);
                    $('spectatorDisplayBox').style.display = 'block';
                    $('leaveBtn').style.display = '';
                    $('specName').innerText = m.name || id;
                    specData = null;
                    activeSpectatorRef = db.ref('streams/' + id + '/data');
                    activeSpectatorRef.on('value', function(s) {
                        specData = s.val();
                        if (!specData) { $('specState').innerText = 'OFFLINE'; $('specBadge').className = 'live-badge off'; }
                        renderSpectator();
                    });
                    clearInterval(specTicker);
                    specTicker = setInterval(renderSpectator, 100);
                    initSpecMap();
                    showToast("TERHUBUNG KE ROOM: " + id);
                });
            }).catch(function() { showToast("GAGAL TERHUBUNG (CEK INTERNET / IZIN DATABASE)", true); })
              .then(function() { btn.disabled = false; });
        }

        function leaveSpectatorRoom(silent) {
            if (activeSpectatorRef) { try { activeSpectatorRef.off(); } catch (e) {} activeSpectatorRef = null; }
            clearInterval(specTicker); specTicker = null; specData = null;
            $('spectatorDisplayBox').style.display = 'none';
            $('leaveBtn').style.display = 'none';
            if (!silent) showToast("KELUAR DARI ROOM");
        }

        function initSpecMap() {
            if (specMap || typeof L === 'undefined') return;
            try {
                specMap = L.map('specMap', { zoomControl: false, attributionControl: false }).setView([-6.2, 106.8], 15);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(specMap);
            } catch (e) { specMap = null; }
            setTimeout(function() { if (specMap) specMap.invalidateSize(); }, 250);
        }

        var STATE_LABEL = { IDLE: 'STANDBY', ARMED: 'ARMED', RUNNING: 'MELAJU', FINISHED: 'FINISH' };
        function renderSpectator() {
            var d = specData; if (!d) return;
            var serverNow = Date.now() + serverOffset;
            var stale = !d.updatedAt || (serverNow - d.updatedAt) > 8000;
            var effNow = stale ? (d.updatedAt || serverNow) : serverNow;

            $('specState').innerText = stale ? 'SINYAL HILANG' : (STATE_LABEL[d.state] || d.state);
            $('specBadge').className = 'live-badge' + (stale || d.state === 'IDLE' ? ' off' : '');
            $('specSpeed').innerText = Math.round(toDisplaySpeed(d.speedKmh || 0));
            $('specUnit').innerText = currentUnit;

            var t = 0;
            if (d.state === 'RUNNING' && d.startEpoch) t = Math.max(0, (effNow - d.startEpoch) / 1000);
            else if (d.state === 'FINISHED' && d.finalTime != null) t = d.finalTime;
            $('specTimer').innerText = t.toFixed(2);

            var pct, tgt;
            if (d.mode === 'dist') { pct = (d.dist || 0) / (d.target || 1) * 100; tgt = 'TARGET: ' + fmtNum(d.target) + ' m  |  ' + (d.dist || 0).toFixed(0) + ' m'; }
            else { pct = (d.speedKmh || 0) / (d.target || 1) * 100; tgt = 'TARGET: 0-' + fmtNum(toDisplaySpeed(d.target)) + ' ' + currentUnit; }
            if (d.state === 'FINISHED') pct = 100;
            $('specProgress').style.width = Math.max(0, Math.min(pct, 100)) + '%';
            $('specTarget').innerText = tgt;
            $('specTop').innerText = 'TOP: ' + Math.round(toDisplaySpeed(d.topKmh || 0)) + ' ' + currentUnit;

            if (specMap && d.lat != null && d.lng != null) {
                if (!specMarker) { specMarker = L.circleMarker([d.lat, d.lng], { color: '#FF2A55', radius: 8, fillColor: '#FF2A55', fillOpacity: 0.85 }).addTo(specMap); specMap.setView([d.lat, d.lng], 17); }
                else {
                    var ll = specMarker.getLatLng();
                    if (ll.lat !== d.lat || ll.lng !== d.lng) { specMarker.setLatLng([d.lat, d.lng]); specMap.panTo([d.lat, d.lng], { animate: true, duration: 0.6 }); }
                }
            }
        }

        /* ================= PETA ================= */
        function initMap() {
            if (map !== null || typeof L === 'undefined') return;
            map = L.map('map').setView([currentLat || -6.2, currentLng || 106.8], 15);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
            map.on('click', function(e) {
                var helpText = $('mapHelpText');
                if (state === 'RUNNING') return;
                if (!customStartMarker) {
                    customStartMarker = L.marker(e.latlng).addTo(map).bindPopup("START").openPopup();
                    helpText.innerText = "START tersetting! Klik titik FINISH di peta.";
                } else if (!customFinishMarker) {
                    customFinishMarker = L.marker(e.latlng).addTo(map).bindPopup("FINISH").openPopup();
                    customTrackLine = L.polyline([customStartMarker.getLatLng(), e.latlng], { color: '#FF2A55', weight: 4, dashArray: '6, 6' }).addTo(map);
                    var dist = calcDistance(customStartMarker.getLatLng().lat, customStartMarker.getLatLng().lng, e.latlng.lat, e.latlng.lng);
                    selectedPresetId = null; setTarget('dist', dist, 'MAP'); renderPresetsGrid();
                    showToast("MAP TRACK: " + dist.toFixed(1) + "M");
                    map.fitBounds(customTrackLine.getBounds());
                    helpText.innerText = "Track dipasang! Buka tab DRAG lalu READY.";
                }
            });
            if (currentLat) userMarker = L.circleMarker([currentLat, currentLng], { color: '#00F2FE', radius: 7, fillColor: '#00F2FE', fillOpacity: 0.8 }).addTo(map);
        }

        function resetCustomTrack() {
            if (map) {
                if (customStartMarker) map.removeLayer(customStartMarker);
                if (customFinishMarker) map.removeLayer(customFinishMarker);
                if (customTrackLine) map.removeLayer(customTrackLine);
            }
            customStartMarker = null; customFinishMarker = null; customTrackLine = null;
            if (state !== 'RUNNING') selectDefaultPreset();
            $('mapHelpText').innerText = "Klik 1x titik START, Klik 1x lagi titik FINISH";
        }

        /* ================= RIWAYAT ================= */
        function saveToHistory(elapsed) {
            var targetName = modeType === 'dist' ? fmtNum(targetValue) + "m" : "0-" + fmtNum(toDisplaySpeed(targetValue)) + currentUnit.toLowerCase();
            var record = { target: targetName, time: elapsed.toFixed(2) + "s", topSpeed: toDisplaySpeed(runTopKmh).toFixed(1) + " " + currentUnit, timestamp: Date.now() };
            record.bike = ((($('bikeName') || {}).value) || '').trim().slice(0, 40);
            try { postLeaderboard(elapsed, record); } catch (e) {}
            record.d = { mode: modeType, tv: targetValue, top: +runTopKmh.toFixed(2), dist: +accumulatedDistance.toFixed(1), acc: +lastAcc.toFixed(1), splits: runSplits.slice(), s: downsampleRun(runSamples, 160) };
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem('racebox_logs') || '[]'); } catch (e) { logs = []; }
            logs.unshift(record); if (logs.length > 10) logs.pop();
            safeSet('racebox_logs', JSON.stringify(logs));
            if (currentUser && !currentUser.isAnonymous && db) { try { var pr = db.ref('users/' + currentUser.uid + '/logs').push(record); if (pr && pr.catch) pr.catch(function() {}); } catch (e) {} }
        }

        function downsampleRun(arr, max) {
            if (arr.length <= max) return arr.slice();
            var out = [], step = (arr.length - 1) / (max - 1);
            for (var i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
            return out;
        }

        function loadHistoryFromFirebase() {
            if (!currentUser || currentUser.isAnonymous || !db) return;
            db.ref('users/' + currentUser.uid + '/logs').limitToLast(10).once('value', function(snapshot) {
                var firebaseLogs = [];
                snapshot.forEach(function(child) { firebaseLogs.unshift(child.val()); });
                var localOld = []; try { localOld = JSON.parse(localStorage.getItem('racebox_logs') || '[]'); } catch (e) {}
                var keepD = {}; localOld.forEach(function(l) { if (l && l.timestamp && l.d) keepD[l.timestamp] = l.d; });
                firebaseLogs.forEach(function(l) { if (l && !l.d && keepD[l.timestamp]) l.d = keepD[l.timestamp]; });
                if (firebaseLogs.length > 0) { safeSet('racebox_logs', JSON.stringify(firebaseLogs)); renderHistory(); }
            }, function() {});
        }

        /* ================= DETAIL RUN ================= */
        function pad2(n) { return (n < 10 ? '0' : '') + n; }
        function distAt(smp, t) {
            if (!smp.length) return 0;
            if (t <= smp[0][0]) return +smp[0][2] || 0;
            for (var i = 1; i < smp.length; i++) {
                if (t <= smp[i][0]) {
                    var a = smp[i - 1], b = smp[i], f = (b[0] - a[0]) > 0 ? (t - a[0]) / (b[0] - a[0]) : 1;
                    return (+a[2] || 0) + f * ((+b[2] || 0) - (+a[2] || 0));
                }
            }
            return +smp[smp.length - 1][2] || 0;
        }
        function rdChart(smp, sp, vmaxKmh) {
            var W = 340, H = 190, pl = 34, pr = 12, pt = 14, pb = 24;
            var tmax = Math.max(1, smp.length ? smp[smp.length - 1][0] : 1, sp.length ? sp[sp.length - 1].t : 1);
            var vm = toDisplaySpeed(vmaxKmh) * 1.08, steps = [20, 50, 100, 150, 200, 300, 400], ymax = steps[steps.length - 1];
            for (var k = 0; k < steps.length; k++) { if (steps[k] >= vm) { ymax = steps[k]; break; } }
            var X = function(t) { return pl + (W - pl - pr) * t / tmax; };
            var Y = function(v) { return pt + (H - pt - pb) * (1 - Math.min(v, ymax) / ymax); };
            var ts = [1, 2, 5, 10, 15, 20, 30, 60], tstep = 60;
            for (var q = 0; q < ts.length; q++) { if (tmax / ts[q] <= 6) { tstep = ts[q]; break; } }
            var g = '';
            [0, 0.5, 1].forEach(function(f) {
                var y = Y(ymax * f);
                g += '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="rgba(255,255,255,0.1)"/><text x="' + (pl - 6) + '" y="' + (y + 3) + '" fill="#8089a0" font-size="9" text-anchor="end">' + Math.round(ymax * f) + '</text>';
            });
            for (var tt = 0; tt <= tmax + 0.001; tt += tstep) {
                g += '<line x1="' + X(tt) + '" y1="' + pt + '" x2="' + X(tt) + '" y2="' + (H - pb) + '" stroke="rgba(255,255,255,0.07)"/><text x="' + X(tt) + '" y="' + (H - 8) + '" fill="#8089a0" font-size="9" text-anchor="middle">' + fmtNum(tt) + 's</text>';
            }
            var pts = smp.map(function(a) { return X(+a[0] || 0).toFixed(1) + ',' + Y(toDisplaySpeed(+a[1] || 0)).toFixed(1); });
            var line = '', area = '';
            if (pts.length > 1) {
                line = '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#00FF87" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
                area = '<polygon points="' + pts.join(' ') + ' ' + X(smp[smp.length - 1][0]).toFixed(1) + ',' + Y(0) + ' ' + X(smp[0][0]).toFixed(1) + ',' + Y(0) + '" fill="rgba(0,255,135,0.16)"/>';
            }
            var dots = '';
            sp.forEach(function(s, i) {
                var last = i === sp.length - 1;
                dots += '<circle cx="' + X(s.t).toFixed(1) + '" cy="' + Y(toDisplaySpeed(s.v)).toFixed(1) + '" r="' + (last ? 5 : 4) + '" fill="' + (last ? '#00FF87' : '#fff') + '" stroke="#00FF87" stroke-width="2"/>';
            });
            return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%; height:auto; display:block;">' + g + area + line + dots + '</svg>';
        }
        function buildRunDetail(l) {
            var d = l.d, isDist = d.mode === 'dist';
            var sp = (Array.isArray(d.splits) ? d.splits : Object.keys(d.splits || {}).map(function(k) { return d.splits[k]; })).filter(Boolean);
            var smp = (Array.isArray(d.s) ? d.s : Object.keys(d.s || {}).map(function(k) { return d.s[k]; })).filter(function(a) { return a && a.length >= 3; });
            var tot = sp.length ? sp[sp.length - 1].t : 0;
            var uShort = currentUnit === 'MPH' ? 'mph' : 'kph';
            var avg = (d.dist > 0 && tot > 0) ? (d.dist / tot) * 3.6 : 0;
            var dt = new Date(l.timestamp || Date.now());
            var dateStr = pad2(dt.getDate()) + '.' + pad2(dt.getMonth() + 1) + '.' + dt.getFullYear();
            var timeStr = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
            var distStr = d.dist >= 1000 ? (d.dist / 1000).toFixed(2) + ' km' : fmtNum(+d.dist || 0) + ' m';
            var h = '';
            h += '<div class="rd-card" style="text-align:center;"><div class="rd-lbl">MAX SPEED</div><div class="digital-font neon-cyan" style="font-size:46px; font-weight:800; margin-top:4px;">' + toDisplaySpeed(+d.top || 0).toFixed(2) + ' <span style="font-size:18px;">' + uShort.toUpperCase() + '</span></div></div>';
            h += '<div class="rd-card"><div style="display:flex; justify-content:space-between; font-size:13px; color:#fff; font-weight:700;"><span>' + dateStr + '</span><span>' + timeStr + '</span></div>';
            h += '<div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-top:4px;"><span>TARGET ' + esc(l.target) + '</span><span>GPS ±' + fmtNum(+d.acc || 0) + ' m</span></div>';
            if (l.bike) h += '<div style="font-size:13px; color:#fff; font-weight:700; margin-top:8px;">🏍️ ' + esc(l.bike) + '</div>';
            h += '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:14px; text-align:center;">';
            h += '<div><div class="rd-lbl">AVG SPEED</div><div class="digital-font" style="font-size:17px; color:var(--cyan); margin-top:4px;">' + toDisplaySpeed(avg).toFixed(1) + ' ' + uShort + '</div></div>';
            h += '<div><div class="rd-lbl">JARAK</div><div class="digital-font" style="font-size:17px; color:#fff; margin-top:4px;">' + distStr + '</div></div>';
            h += '<div><div class="rd-lbl">WAKTU</div><div class="digital-font" style="font-size:17px; color:var(--yellow); margin-top:4px;">' + tot.toFixed(2) + ' s</div></div></div></div>';
            h += '<div class="rd-card" style="padding:12px 10px;"><div class="rd-lbl" style="margin:0 0 6px 6px;">KECEPATAN (' + uShort.toUpperCase() + ') TERHADAP WAKTU</div>' + rdChart(smp, sp, +d.top || 0) + '</div>';
            h += '<div style="text-align:center; color:#fff; font-weight:800; font-size:15px; letter-spacing:1px; margin:6px 0 0;">' + (isDist ? 'DRAG RESULT' : 'ACCELERATION RESULT') + '</div>';
            sp.forEach(function(s, i) {
                var last = i === sp.length - 1;
                var label = isDist ? fmtNum(s.m) + ' m' : '0-' + fmtNum(toDisplaySpeed(s.m)) + ' ' + uShort;
                var right = isDist ? toDisplaySpeed(s.v).toFixed(2) + ' ' + uShort : distAt(smp, s.t).toFixed(1) + ' m';
                h += '<div class="rd-split' + (last ? ' last' : '') + '"><b>' + (last ? '● ' : '') + label + '</b><span>' + (+s.t).toFixed(3) + ' s</span><em>' + right + '</em></div>';
            });
            return h;
        }
        function openRunDetail(i) {
            var logs = []; try { logs = JSON.parse(localStorage.getItem('racebox_logs') || '[]'); } catch (e) {}
            var l = logs[i];
            if (!l || !l.d || !l.d.splits || !Object.keys(l.d.splits).length) { showToast("LOG LAMA - TIDAK ADA DETAIL", true); return; }
            try {
                $('rdTitle').innerText = l.d.mode === 'dist' ? 'DRAG SESSION OVERVIEW' : 'ACCELERATION OVERVIEW';
                $('rdBody').innerHTML = buildRunDetail(l);
            } catch (e) { showToast("DETAIL GAGAL DITAMPILKAN", true); return; }
            $('rdBody').scrollTop = 0;
            $('runDetail').className = 'rd-overlay show';
        }
        function closeRunDetail() { $('runDetail').className = 'rd-overlay'; }

        function renderHistory() {
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem('racebox_logs') || '[]'); } catch (e) { logs = []; }
            var tbody = $('historyBody');
            if (logs.length === 0) { tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#555;">Belum ada catatan run</td></tr>'; return; }
            var rows = '';
            for (var i = 0; i < logs.length; i++) {
                var l = logs[i];
                rows += '<tr class="hrow" onclick="openRunDetail(' + i + ')"><td style="font-weight:700; color:var(--cyan);">' + esc(l.target) + (l.bike ? '<div style="font-size:10px; color:var(--muted); font-weight:600;">🏍️ ' + esc(l.bike) + '</div>' : '') + '</td><td style="font-weight:700; color:var(--yellow);">' + esc(l.time) + '</td><td style="color:var(--green);">' + esc(l.topSpeed) + (l.d ? ' <span style="color:var(--cyan); font-size:15px;">›</span>' : '') + '</td></tr>';
            }
            tbody.innerHTML = rows;
        }

        function clearHistory() {
            localStorage.removeItem('racebox_logs');
            if (currentUser && !currentUser.isAnonymous && db) { try { db.ref('users/' + currentUser.uid + '/logs').remove(); } catch (e) {} }
            renderHistory();
        }

        /* ================= PENGATURAN ================= */
        function toggleSoundSetting(val) { soundEnabled = val; safeSet('racebox_sound', val); }

        function changeSpeedUnit(unit) {
            if (unit !== 'MPH') unit = 'KM/H';
            currentUnit = unit;
            $('unitLabel1').innerText = unit;
            $('unitSelect').value = unit;
            $('offsetValText').innerText = (speedOffset >= 0 ? "+" : "") + speedOffset + " " + unit;
            renderSpeed(); refreshTargetLabel(); updateUI();
            safeSet('racebox_unit', unit);
        }

        function clearHistoryAsk() {
            sysModal({ icon: '🗑️', title: 'HAPUS SEMUA LOG RUN?', msg: 'Seluruh riwayat run (lokal dan cloud) akan dihapus dan tidak bisa dikembalikan. Pengaturan & akunmu tidak ikut terhapus.',
                buttons: [{ text: 'BATAL' }, { text: 'YA, HAPUS', cls: 'sys-danger', fn: function() { clearHistory(); showToast("LOG RUN DIHAPUS"); } }] });
        }
        function changeAutoSens(v) { autoSensIdx = Math.max(0, Math.min(2, parseInt(v, 10) || 1)); safeSet('racebox_autosens', autoSensIdx); showToast("SENSITIVITAS AUTO-START DISIMPAN"); }
        function toggleKeepAwake(v) {
            keepAwake = v; safeSet('racebox_awake', v);
            if (v) { if (sensorsOn) requestWakeLock(); }
            else if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
        }
        function renderAppInfo() {
            var n = 0; try { n = JSON.parse(localStorage.getItem('racebox_logs') || '[]').length; } catch (e) {}
            var el = $('appInfo'); if (!el) return;
            el.innerHTML = 'Versi: <b style="color:#fff;">RaceBox PRO v' + APP_VER + '</b><br>Perangkat: <b style="color:#fff;">' + esc(deviceToken.slice(-6).toUpperCase()) + '</b><br>Koneksi: <b style="color:' + (navigator.onLine ? '#00FF87' : '#FF2A55') + ';">' + (navigator.onLine ? 'ONLINE' : 'OFFLINE') + '</b><br>GPS & Sensor: <b style="color:#fff;">' + (sensorsOn ? 'AKTIF' : 'BELUM AKTIF') + '</b><br>Log tersimpan: <b style="color:#fff;">' + n + ' run</b>';
        }
        window.addEventListener('online', renderAppInfo); window.addEventListener('offline', renderAppInfo);
        setInterval(renderAppInfo, 5000);

        window.addEventListener('beforeunload', function() { if (activeHostSession && db) { try { db.ref('streams/' + activeHostSession).remove(); } catch (e) {} } });

        (function loadSettings() {
            var savedBg = localStorage.getItem('racebox_custom_bg');
            if (savedBg) setBackground(savedBg);
            var savedSound = localStorage.getItem('racebox_sound');
            if (savedSound !== null) { soundEnabled = (savedSound === 'true'); $('soundToggle').checked = soundEnabled; }
            var h = localStorage.getItem('racebox_host_id'); if (h) $('hostSessionId').value = h;
            var j = localStorage.getItem('racebox_join_id'); if (j) $('joinSessionId').value = j;
            var as = parseInt(localStorage.getItem('racebox_autosens'), 10); if (as >= 0 && as <= 2) autoSensIdx = as;
            $('sensSelect').value = String(autoSensIdx);
            if (localStorage.getItem('racebox_awake') === 'false') { keepAwake = false; $('awakeToggle').checked = false; }
            renderAppInfo();
            selectDefaultPreset();
            changeSpeedUnit(localStorage.getItem('racebox_unit') || 'KM/H');
        })();
