(function () {
    'use strict';

    var obj = window.rzk_obj || {};

    function cfg(key, fallback) {
        return (obj && typeof obj[key] !== 'undefined') ? obj[key] : fallback;
    }

    var RESEND_COOLDOWN = parseInt(cfg('resend_cooldown', 60), 10) || 60;

    var state = {
        phone: '',
        isExisting: false,
        timer: null,
        redirect: '',
        is2FA: false,
        lastFocused: null
    };

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function emit(name, detail) {
        try {
            document.dispatchEvent(new CustomEvent(name, { detail: detail || {}, bubbles: true }));
        } catch (e) {}
    }

    /**
     * Normalize Persian/Arabic digits to English.
     */
    function normalizeDigits(str) {
        if (!str) return '';
        var fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹', '٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
        var en = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        for (var i = 0; i < fa.length; i++) {
            str = str.split(fa[i]).join(en[i]);
        }
        return str;
    }

    /**
     * Read a localized template from a data-template attribute.
     */
    function tplText(el, vars) {
        if (!el) return '';
        var text = el.getAttribute('data-template') || el.textContent || '';
        Object.keys(vars || {}).forEach(function (k) {
            text = text.split('{' + k + '}').join(vars[k]);
        });
        return text;
    }

    function stepEl(id) { return document.getElementById(id); }

    function showStep(id) {
        $$('.rzk-step').forEach(function (el) {
            el.classList.remove('active');
            el.style.display = 'none';
        });
        var step = stepEl(id);
        if (!step) return;
        step.style.display = 'block';
        // force a frame so the entering animation runs
        void step.offsetWidth;
        step.classList.add('active');

        // Keep the dialog name in step with the heading the user can see.
        var heading = step.querySelector('h3');
        var modal = $('#rzk-modal');
        if (modal && heading && heading.id) {
            modal.setAttribute('aria-labelledby', heading.id);
        }

        var first = step.querySelector('input:not([type=hidden]):not([type=checkbox]), button:not(.rzk-back-link)');
        if (first) {
            requestAnimationFrame(function () { first.focus(); });
        }
    }

    /**
     * Error feedback: text plus aria-invalid on the field that caused it.
     */
    function setError(stepId, text, field) {
        var step = stepEl(stepId);
        if (!step) return;
        var box = step.querySelector('.rzk-msg');
        if (box) box.textContent = text || '';
        $$('input, .rzk-otp-field', step).forEach(function (el) {
            el.removeAttribute('aria-invalid');
            if (el.classList.contains('rzk-otp-field')) el.removeAttribute('data-invalid');
        });
        if (field) {
            if (field.classList && field.classList.contains('rzk-otp-field')) {
                field.setAttribute('data-invalid', 'true');
            } else {
                field.setAttribute('aria-invalid', 'true');
            }
            if (typeof field.focus === 'function') field.focus();
        }
    }

    function clearError(stepId) {
        var step = stepEl(stepId);
        if (!step) return;
        var box = step.querySelector('.rzk-msg');
        if (box) box.textContent = '';
        $$('input', step).forEach(function (el) { el.removeAttribute('aria-invalid'); });
        $$('.rzk-otp-field', step).forEach(function (el) { el.removeAttribute('data-invalid'); });
    }

    /**
     * Loading state. The idle label always comes from the rendered markup,
     * so custom button text in the settings survives a request.
     */
    function busy(btn, isLoading) {
        if (!btn) return;
        if (isLoading) {
            if (!btn.dataset.idle) btn.dataset.idle = btn.textContent.trim();
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.innerHTML = '<span class="rzk-spinner" aria-hidden="true"></span><span>' +
                (btn.dataset.busy || 'در حال بررسی…') + '</span>';
        } else {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = btn.dataset.idle || '';
        }
    }

    function errorText(data) {
        if (!data) return 'درخواست شکست خورد؛ دوباره امتحان کنید.';
        if (typeof data === 'string') return data;
        if (typeof data.message === 'string') return data.message;
        return 'درخواست شکست خورد؛ دوباره امتحان کنید.';
    }

    function post(action, data, btn, onDone) {
        var body = new URLSearchParams();
        body.append('action', action);
        body.append('nonce', cfg('nonce', ''));
        if (state.redirect) body.append('redirect', state.redirect);

        Object.keys(data).forEach(function (k) { body.append(k, data[k]); });

        fetch(cfg('ajax_url', ''), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString()
        })
            .then(function (r) { return r.json(); })
            .then(function (res) { onDone(res || {}); })
            .catch(function () {
                onDone({
                    success: false,
                    data: 'ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.'
                });
            })
            .finally(function () {
                if (btn) busy(btn, false);
            });
    }

    function handleSuccess(res) {
        var target = (res && res.data && res.data.redirect) ? res.data.redirect : '';
        if (!target) target = state.redirect || cfg('redirect', '');

        emit('rzk:login-success', { phone: state.phone, redirect: target });
        showStep('rzk-step-success');

        setTimeout(function () {
            if (target) {
                window.location.href = target;
            } else {
                location.reload();
            }
        }, 1100);
    }

    /* ---------- Modal open / close ---------- */

    function focusables() {
        var overlay = $('#rzk-modal-overlay');
        if (!overlay) return [];
        return $$('a[href], button:not([disabled]), input:not([type=hidden]), [tabindex]:not([tabindex="-1"])', overlay)
            .filter(function (el) { return el.offsetParent !== null; });
    }

    function openModal(trigger) {
        var overlay = $('#rzk-modal-overlay');
        if (!overlay) return;

        state.lastFocused = trigger || document.activeElement;
        state.redirect = (trigger && trigger.getAttribute('data-redirect')) ||
            overlay.getAttribute('data-redirect') ||
            cfg('redirect', '');

        overlay.classList.add('rzk-open');
        document.body.dataset.rzkScroll = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        showStep('rzk-step-phone');
        clearError('rzk-step-phone');
        emit('rzk:modal-open', { trigger: trigger });
        initGoogle();
    }

    function closeModal() {
        var overlay = $('#rzk-modal-overlay');
        if (!overlay) return;
        overlay.classList.remove('rzk-open');
        document.body.style.overflow = document.body.dataset.rzkScroll || '';
        if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
            state.lastFocused.focus();
        }
        stopCountdown();
        emit('rzk:modal-close');
    }

    document.addEventListener('click', function (e) {
        var trigger = e.target.closest('.rzk-trigger-btn');
        if (trigger) {
            e.preventDefault();
            openModal(trigger);
            return;
        }
        if (e.target.closest('.rzk-close') ||
            (e.target.closest('#rzk-modal-overlay') && !e.target.closest('.rzk-modal-box'))) {
            closeModal();
        }
    });

    document.addEventListener('keydown', function (e) {
        var overlay = $('#rzk-modal-overlay');
        if (!overlay || !overlay.classList.contains('rzk-open')) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal();
            return;
        }

        if (e.key === 'Tab') {
            var nodes = focusables();
            if (!nodes.length) return;
            var first = nodes[0];
            var last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    /* ---------- Back to phone ---------- */

    $$('.rzk-back-link').forEach(function (el) {
        el.addEventListener('click', function () {
            stopCountdown();
            state.is2FA = false;
            clearError('rzk-step-phone');
            clearError('rzk-step-otp');
            clearError('rzk-step-password');
            showStep('rzk-step-phone');
        });
    });

    /* ---------- Captcha ---------- */

    function refreshCaptcha() {
        var refreshBtn = $('#rzk-captcha-refresh');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        post('rzk_refresh_captcha', {}, null, function (res) {
            if (refreshBtn) refreshBtn.classList.remove('spinning');
            if (res.success && res.data) {
                if ($('#rzk-captcha-question')) $('#rzk-captcha-question').textContent = res.data.question;
                if ($('#rzk-captcha-token')) $('#rzk-captcha-token').value = res.data.token;
                if ($('#rzk-captcha-input')) $('#rzk-captcha-input').value = '';
            }
        });
    }

    document.addEventListener('click', function (e) {
        if (e.target.closest('#rzk-captcha-refresh')) {
            e.preventDefault();
            refreshCaptcha();
        }
    });

    /* ---------- Digit-only inputs ---------- */

    var phoneInput = $('#rzk-phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', function () {
            var val = normalizeDigits(this.value).replace(/[^\d]/g, '');
            if (val.length > 11) val = val.substring(0, 11);
            this.value = val;
            if (this.getAttribute('aria-invalid') === 'true') clearError('rzk-step-phone');
        });
    }

    var captchaInput = $('#rzk-captcha-input');
    if (captchaInput) {
        captchaInput.addEventListener('input', function () {
            this.value = normalizeDigits(this.value).replace(/[^\d\-]/g, '');
            if (this.getAttribute('aria-invalid') === 'true') clearError('rzk-step-phone');
        });
    }

    var termsBox = $('#rzk-terms-agree');
    if (termsBox) {
        termsBox.addEventListener('change', function () {
            if (termsBox.checked) clearError('rzk-step-phone');
        });
    }

    /* ---------- Step 1: phone ---------- */

    var btnCheck = $('#btn-check-phone');
    if (btnCheck) {
        btnCheck.addEventListener('click', function () {
            var btn = this;
            var raw = normalizeDigits(phoneInput ? phoneInput.value : '').replace(/[\s-]/g, '');

            if (!/^09\d{9}$/.test(raw)) {
                setError('rzk-step-phone', 'شماره موبایل باید ۱۱ رقم باشد و با ۰۹ شروع شود.', phoneInput);
                return;
            }

            var postData = { phone: raw };

            if (cfg('captcha_enabled', false) && captchaInput) {
                var ans = normalizeDigits(captchaInput.value).trim();
                var token = $('#rzk-captcha-token') ? $('#rzk-captcha-token').value : '';
                if (ans === '') {
                    setError('rzk-step-phone', 'حاصل عبارت ریاضی را وارد کنید.', captchaInput);
                    return;
                }
                postData.captcha_ans = ans;
                postData.captcha_token = token;
            }

            if (cfg('terms_enabled', false) && termsBox && !termsBox.checked) {
                setError('rzk-step-phone', 'برای عضویت باید قوانین سایت را بپذیرید.', termsBox);
                return;
            }
            if (cfg('terms_enabled', false) && termsBox) {
                postData.terms = 1;
            }

            state.phone = raw;
            clearError('rzk-step-phone');
            busy(btn, true);

            post('rzk_check_phone', postData, btn, function (res) {
                if (!res.success) {
                    setError('rzk-step-phone', errorText(res.data));
                    if (cfg('captcha_enabled', false)) refreshCaptcha();
                    return;
                }

                state.isExisting = (res.data && res.data.status === 'exists');

                if (state.isExisting) {
                    var welcomeEl = $('#user-welcome-name');
                    if (welcomeEl) {
                        welcomeEl.textContent = tplText(welcomeEl, {
                            name: (res.data && res.data.name) ? res.data.name : 'دوست عزیز'
                        });
                    }
                    clearError('rzk-step-password');
                    showStep('rzk-step-password');
                    return;
                }

                if (cfg('bale', false)) {
                    var channel = cfg('chat', 'پیام‌رسان');
                    var titleEl = $('.rzk-chat-title');
                    var descEl = $('.rzk-chat-desc');
                    if (titleEl) titleEl.textContent = tplText(titleEl, { channel: channel });
                    if (descEl) descEl.textContent = tplText(descEl, { channel: channel });
                    clearError('rzk-step-bale');
                    showStep('rzk-step-bale');
                } else {
                    sendOtp();
                }
            });
        });

        if (phoneInput) {
            phoneInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    btnCheck.click();
                }
            });
        }
    }

    /* ---------- Step 2A: password + 2FA ---------- */

    var passwordInput = $('#rzk-password');
    var btnLoginPass = $('#btn-login-pass');

    if (btnLoginPass) {
        btnLoginPass.addEventListener('click', function () {
            var btn = this;
            var pass = passwordInput ? passwordInput.value : '';
            if (!pass) {
                setError('rzk-step-password', 'رمز عبور را وارد کنید.', passwordInput);
                return;
            }

            clearError('rzk-step-password');
            busy(btn, true);

            post('rzk_login_pass', { phone: state.phone, password: pass }, btn, function (res) {
                if (res.success) {
                    if (res.data && res.data.status === '2fa_required') {
                        state.is2FA = true;
                        var desc = $('#rzk-otp-desc');
                        if (desc) desc.textContent = 'کد تایید دومرحله‌ای به شماره ' + state.phone + ' ارسال شد.';
                        if ($('#rzk-fullname-wrap')) $('#rzk-fullname-wrap').style.display = 'none';
                        var verifyBtn = $('#btn-verify-otp');
                        if (verifyBtn) {
                            verifyBtn.dataset.idle = 'تایید و ورود';
                            verifyBtn.textContent = 'تایید و ورود';
                        }
                        startCountdown();
                        showStep('rzk-step-otp');
                        emit('rzk:2fa-required', { phone: state.phone });
                        return;
                    }
                    handleSuccess(res);
                    return;
                }
                setError('rzk-step-password', errorText(res.data), passwordInput);
            });
        });

        if (passwordInput) {
            passwordInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    btnLoginPass.click();
                }
            });
        }
    }

    var useOtp = $('#rzk-use-otp');
    if (useOtp) {
        useOtp.addEventListener('click', function () {
            if (cfg('bale', false)) {
                showStep('rzk-step-bale');
            } else {
                sendOtp();
            }
        });
    }

    /* ---------- Step 2B: chat id ---------- */

    var btnSendBale = $('#btn-send-bale');
    if (btnSendBale) {
        btnSendBale.addEventListener('click', function () {
            var btn = this;
            var chatInput = $('#rzk-bale-id');
            var chatId = normalizeDigits(chatInput ? chatInput.value : '').trim().replace('@', '');
            var isNumeric = /^\d{4,15}$/.test(chatId);
            var isUsername = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(chatId);

            if (!(isNumeric || (!cfg('only_numeric_chat', false) && isUsername))) {
                setError('rzk-step-bale', 'شناسه ' + cfg('chat', 'پیام‌رسان') + ' معتبر نیست.', chatInput);
                return;
            }

            clearError('rzk-step-bale');
            busy(btn, true);
            sendOtp(chatId);
        });
    }

    /* ---------- OTP request ---------- */

    function sendOtp(baleId) {
        var active = document.querySelector('.rzk-step.active');
        var fromId = active ? active.id : 'rzk-step-phone';

        var data = { phone: state.phone };
        if (baleId) data.bale_id = baleId;

        var btn = fromId === 'rzk-step-bale' ? btnSendBale : null;

        post('rzk_send_otp', data, btn, function (res) {
            if (!res.success) {
                setError(fromId, errorText(res.data));
                return;
            }

            var chatValue = $('#rzk-bale-id');
            var dest = cfg('bale', false)
                ? ((cfg('chat', 'بله') + ' · ' + normalizeDigits(chatValue ? chatValue.value : '').trim().replace('@', '')))
                : state.phone;

            var desc = $('#rzk-otp-desc');
            if (desc) desc.textContent = tplText(desc, { dest: dest });

            if ($('#rzk-fullname-wrap')) {
                $('#rzk-fullname-wrap').style.display = (state.isExisting || state.is2FA) ? 'none' : '';
            }
            var verifyBtn = $('#btn-verify-otp');
            if (verifyBtn) {
                var idle = (state.isExisting || state.is2FA) ? 'تایید و ورود' : 'ثبت‌نام و ورود';
                verifyBtn.dataset.idle = idle;
                verifyBtn.textContent = idle;
            }

            startCountdown();
            showStep('rzk-step-otp');
            clearError('rzk-step-otp');
            if ($('#rzk-otp-input')) $('#rzk-otp-input').value = '';
            syncOtpSlots();

            emit('rzk:otp-sent', {
                phone: state.phone,
                dest: dest,
                via: (res.data && res.data.via) ? res.data.via : 'sms'
            });
        });
    }

    /* ---------- Resend cooldown ---------- */

    var resendBtn = $('#rzk-resend');
    var countdownEl = $('#rzk-countdown');

    function setCountdown(left) {
        if (!countdownEl) return;
        countdownEl.textContent = left > 0 ? ' · ' + left + ' ثانیه' : '';
    }

    function startCountdown() {
        stopCountdown();
        var left = parseInt(cfg('resend_cooldown', RESEND_COOLDOWN), 10) || RESEND_COOLDOWN;
        if (resendBtn) resendBtn.style.display = 'none';
        setCountdown(left);

        state.timer = setInterval(function () {
            left--;
            if (left <= 0) {
                stopCountdown();
                return;
            }
            setCountdown(left);
        }, 1000);
    }

    function stopCountdown() {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        if (resendBtn) resendBtn.style.display = '';
        if (countdownEl) countdownEl.textContent = '';
    }

    if (resendBtn) {
        resendBtn.addEventListener('click', function () {
            if (this.disabled) return;
            var chatInput = $('#rzk-bale-id');
            if (cfg('bale', false)) {
                sendOtp(normalizeDigits(chatInput ? chatInput.value : '').trim().replace('@', ''));
            } else {
                sendOtp();
            }
        });
    }

    /* ---------- Step 3: OTP ---------- */

    var otpInput = $('#rzk-otp-input');
    var otpSlots = $$('#rzk-otp-slots .rzk-otp-slot');

    function syncOtpSlots() {
        var val = otpInput ? otpInput.value : '';
        otpSlots.forEach(function (slot, i) {
            slot.textContent = val.charAt(i) || '';
            slot.classList.toggle('is-filled', !!val.charAt(i));
            slot.classList.toggle('is-active', i === val.length);
        });
    }

    if (otpInput) {
        otpInput.addEventListener('input', function () {
            var otpLen = parseInt(this.getAttribute('data-otp-length') || cfg('otp_length', 6), 10);
            var val = normalizeDigits(this.value).replace(/[^\d]/g, '');
            if (val.length > otpLen) val = val.substring(0, otpLen);
            this.value = val;
            syncOtpSlots();

            if (this.getAttribute('aria-invalid') === 'true') clearError('rzk-step-otp');

            if (val.length === otpLen && !btnVerify.disabled) {
                btnVerify.click();
            }
        });

        otpInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                btnVerify.click();
            }
        });

        // Clicking anywhere in the slots area focuses the real input.
        document.addEventListener('click', function (e) {
            var field = e.target.closest('.rzk-otp-field');
            if (field && !e.target.closest('input')) {
                var input = field.querySelector('.rzk-otp-input');
                if (input) input.focus();
            }
        });
    }

    var btnVerify = $('#btn-verify-otp');
    if (btnVerify) {
        btnVerify.addEventListener('click', function () {
            var btn = this;
            if (btn.disabled) return;

            var code = normalizeDigits(otpInput ? otpInput.value : '').trim();
            var otpLen = parseInt((otpInput && otpInput.getAttribute('data-otp-length')) || cfg('otp_length', 6), 10);

            if (!new RegExp('^\\d{' + otpLen + '}$').test(code)) {
                setError('rzk-step-otp', 'کد ' + otpLen + ' رقمی را کامل وارد کنید.', $('#rzk-otp-field'));
                return;
            }

            clearError('rzk-step-otp');
            busy(btn, true);

            var data = { phone: state.phone, code: code };
            if (!state.isExisting && !state.is2FA) {
                data.name = $('#rzk-fullname') ? $('#rzk-fullname').value : '';
                if (cfg('terms_enabled', false)) data.terms = 1;
            }

            post('rzk_verify_otp', data, btn, function (res) {
                if (res.success) {
                    handleSuccess(res);
                    return;
                }
                setError('rzk-step-otp', errorText(res.data), $('#rzk-otp-field'));
                if (otpInput) {
                    otpInput.value = '';
                    syncOtpSlots();
                    otpInput.focus();
                }
            });
        });
    }

    /* ---------- Google Sign-In ---------- */

    var googleInitialized = false;
    var googleRetries = 0;
    var GOOGLE_MAX_RETRIES = 25; // ~7.5s

    function initGoogle() {
        if (!cfg('google_enabled', false) || !cfg('google_client_id', '')) return;
        if (googleInitialized) return;

        if (!window.google || !window.google.accounts || !window.google.accounts.id) {
            if (googleRetries++ < GOOGLE_MAX_RETRIES) {
                setTimeout(initGoogle, 300);
            }
            return;
        }

        try {
            google.accounts.id.initialize({
                client_id: cfg('google_client_id', ''),
                callback: handleGoogleCredential,
                auto_select: false,
                cancel_on_tap_outside: true
            });

            googleInitialized = true;

            var btnGoogle = $('#btn-rzk-google');
            if (btnGoogle) {
                btnGoogle.addEventListener('click', function (e) {
                    e.preventDefault();
                    google.accounts.id.prompt();
                });
            }
        } catch (err) {}
    }

    function handleGoogleCredential(response) {
        if (!response || !response.credential) return;

        var btn = $('#btn-rzk-google');
        busy(btn, true);

        post('rzk_google_login', { credential: response.credential }, btn, function (res) {
            if (res.success) {
                handleSuccess(res);
            } else {
                setError('rzk-step-phone', errorText(res.data));
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGoogle);
    } else {
        initGoogle();
    }

    // Keep the visual slots in sync if the browser autofills the code.
    syncOtpSlots();
})();
