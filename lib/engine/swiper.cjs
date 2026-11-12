'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only declarative, bounded options cross the AI-to-JavaScript boundary.
const URLS = Object.freeze({
    css_url: 'https://cdn.jsdelivr.net/npm/swiper@12.0.3/swiper-bundle.min.css',
    jquery_url: 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
    swiper_url: 'https://cdn.jsdelivr.net/npm/swiper@12.0.3/swiper-bundle.min.js'
});
const BEM = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?(?:--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?';
const SELECTOR = new RegExp(`^\\.swiper\\.(${BEM})$`);
const CONTROL_SELECTOR = new RegExp(`^\\.${BEM}$`);
const SWIPER_CLASSES = new Set(['swiper', 'swiper-wrapper', 'swiper-slide', 'swiper-button-next', 'swiper-button-prev', 'swiper-pagination', 'swiper-scrollbar']);

function usesVertical(config) {
    return config.direction === 'vertical' || Object.values(config.breakpoints || {}).some(point => point.direction === 'vertical');
}

function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be a plain object.`);
    return value;
}

function keys(value, allowed, name) {
    object(value, name);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`Unsupported ${name} option: ${key}.`);
    }
}

function number(value, name, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its numeric budget.`);
    return value;
}

function boolean(value, name) {
    if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
    return value;
}

function options(value, breakpoint = false) {
    const allowed = breakpoint
        ? ['slidesPerView', 'slidesPerGroup', 'spaceBetween', 'direction', 'centeredSlides']
        : ['loop', 'rewind', 'watchSlidesProgress', 'speed', 'autoplay', 'breakpoints', 'slidesPerView', 'slidesPerGroup', 'spaceBetween', 'direction', 'centeredSlides', 'allowTouchMove', 'navigation', 'pagination', 'videoAutoplay', 'scrollbar', 'mousewheel', 'lazy', 'freeMode', 'lazyPreloaderClass', 'loopAddBlankSlides', 'effect', 'creativeEffect', 'coverflowEffect', 'thumbs'];
    keys(value, allowed, 'Swiper');
    const result = {};
    for (const key of allowed) {
        if (!Object.hasOwn(value, key)) continue;
        const item = value[key];
        if (['loop', 'rewind', 'watchSlidesProgress', 'centeredSlides', 'allowTouchMove', 'lazy', 'freeMode', 'loopAddBlankSlides'].includes(key)) result[key] = boolean(item, key);
        else if (key === 'slidesPerView') result[key] = item === 'auto' ? item : number(item, key, 0.1, 24);
        else if (key === 'slidesPerGroup') {
            result[key] = number(item, key, 1, 24);
            if (!Number.isInteger(item)) throw new Error('slidesPerGroup must be an integer.');
        } else if (key === 'spaceBetween') {
            if (item !== 0) throw new Error('Swiper spaceBetween must always be 0; use CSS slide padding and negative container margin.');
            result[key] = 0;
        } else if (key === 'speed') result[key] = number(item, key, 0, 10000);
        else if (key === 'direction') {
            if (!['horizontal', 'vertical'].includes(item)) throw new Error('Invalid Swiper direction.');
            result[key] = item;
        } else if (key === 'autoplay') {
            if (item === false) result[key] = false;
            else {
                keys(item, ['delay', 'disableOnInteraction', 'pauseOnMouseEnter', 'reverseDirection'], key);
                result[key] = { delay: 2500, disableOnInteraction: false };
                if (Object.hasOwn(item, 'delay')) result[key].delay = number(item.delay, 'autoplay delay', 250, 600000);
                for (const flag of ['disableOnInteraction', 'pauseOnMouseEnter', 'reverseDirection']) {
                    if (Object.hasOwn(item, flag)) result[key][flag] = boolean(item[flag], flag);
                }
            }
        } else if (key === 'breakpoints') {
            object(item, key);
            if (Object.keys(item).length > 16) throw new Error('Too many Swiper breakpoints.');
            result[key] = {};
            for (const width of Object.keys(item).sort((a, b) => Number(a) - Number(b))) {
                if (!/^(0|[1-9][0-9]{0,4})$/.test(width) || Number(width) > 16384) throw new Error('Invalid Swiper breakpoint.');
                result[key][width] = options(item[width], true);
            }
        } else if (key === 'navigation') {
            if (typeof item === 'boolean') result[key] = item;
            else {
                keys(item, ['nextEl', 'prevEl'], key);
                result[key] = {};
                for (const control of ['nextEl', 'prevEl']) {
                    if (typeof item[control] !== 'string' || item[control].length > 160 || !CONTROL_SELECTOR.test(item[control])) throw new Error('Navigation requires a single BEM class selector.');
                    result[key][control] = item[control];
                }
            }
        } else if (key === 'lazyPreloaderClass') {
            if (item !== 'swiper-lazy-preloader') throw new Error('Invalid Swiper lazy preloader class.');
            result[key] = item;
        } else if (key === 'effect') {
            if (!['slide', 'creative', 'coverflow'].includes(item)) throw new Error('Unsupported Swiper effect.');
            result[key] = item;
        } else if (key === 'coverflowEffect') {
            keys(item, ['rotate', 'stretch', 'depth', 'modifier', 'scale', 'slideShadows'], key);
            result[key] = {};
            for (const option of ['rotate', 'stretch', 'depth', 'modifier', 'scale', 'slideShadows']) {
                if (!Object.hasOwn(item, option)) continue;
                const setting = item[option];
                if (option === 'slideShadows') result[key][option] = boolean(setting, option);
                else if (option === 'rotate') result[key][option] = number(setting, option, -180, 180);
                else if (option === 'depth') result[key][option] = number(setting, option, 0, 10000);
                else if (option === 'modifier') result[key][option] = number(setting, option, 0, 10);
                else if (option === 'scale') result[key][option] = number(setting, option, 0, 1);
                else if (typeof setting === 'number') result[key][option] = number(setting, option, -1000, 1000);
                else {
                    if (typeof setting !== 'string' || !/^-?(?:\d{1,4}(?:\.\d{1,3})?)%$/.test(setting) || Math.abs(parseFloat(setting)) > 1000) throw new Error('Coverflow stretch requires a bounded number or percentage.');
                    result[key][option] = setting;
                }
            }
        } else if (key === 'creativeEffect') {
            keys(item, ['prev', 'next'], key);
            result[key] = {};
            for (const side of ['prev', 'next']) {
                if (!Object.hasOwn(item, side)) continue;
                const transform = item[side];
                keys(transform, ['shadow', 'translate'], 'creative transform');
                const output = {};
                if (Object.hasOwn(transform, 'shadow')) output.shadow = boolean(transform.shadow, 'shadow');
                if (!Array.isArray(transform.translate) || transform.translate.length !== 3) throw new Error('Creative translate requires three bounded coordinates.');
                output.translate = transform.translate.map(coordinate => {
                    if (typeof coordinate === 'number') return number(coordinate, 'translate', -10000, 10000);
                    if (typeof coordinate !== 'string' || !/^-?(?:\d{1,4}(?:\.\d{1,3})?)%$/.test(coordinate) || Math.abs(parseFloat(coordinate)) > 1000) throw new Error('Creative translate requires numeric or percentage coordinates.');
                    return coordinate;
                });
                result[key][side] = output;
            }
        } else if (key === 'thumbs') {
            keys(item, ['swiper', 'multipleActiveThumbs'], key);
            if (typeof item.swiper !== 'string' || !SELECTOR.test(item.swiper) || item.swiper.length > 160) throw new Error('Thumbs swiper must reference a declared Swiper selector.');
            result[key] = { swiper: item.swiper, multipleActiveThumbs: item.multipleActiveThumbs === undefined ? false : boolean(item.multipleActiveThumbs, 'multipleActiveThumbs') };
        } else if (key === 'scrollbar') {
            keys(item, ['el', 'draggable', 'hide'], key);
            if (typeof item.el !== 'string' || item.el.length > 180 || !(item.el.endsWith(' .swiper-scrollbar') && SELECTOR.test(item.el.slice(0, -' .swiper-scrollbar'.length)))) throw new Error('Scrollbar requires an owned Swiper selector.');
            result[key] = { el: item.el, draggable: boolean(item.draggable, 'draggable'), hide: boolean(item.hide, 'hide') };
        } else if (key === 'mousewheel') {
            keys(item, ['forceToAxis', 'sensitivity', 'releaseOnEdges'], key);
            result[key] = { forceToAxis: boolean(item.forceToAxis, 'forceToAxis'), sensitivity: number(item.sensitivity, 'sensitivity', 0.1, 10), releaseOnEdges: boolean(item.releaseOnEdges, 'releaseOnEdges') };
        } else if (key === 'pagination') result[key] = boolean(item, key);
        else if (key === 'videoAutoplay') {
            if (typeof item === 'boolean') result[key] = item;
            else {
                keys(item, ['endDelay', 'errorDelay', 'slideDelay'], key);
                result[key] = {};
                for (const delay of ['endDelay', 'errorDelay', 'slideDelay']) {
                    if (Object.hasOwn(item, delay)) result[key][delay] = number(item[delay], delay, 0, 600000);
                }
            }
        }
    }
    return result;
}

function normalize(value = []) {
    if (!Array.isArray(value) || value.length > 20) throw new Error('swipers must be an array of at most 20 configurations.');
    const seen = new Set();
    const entries = value.map(entry => {
        keys(entry, ['selector', 'mobile_only', 'config'], 'swipers entry');
        if (typeof entry.selector !== 'string' || entry.selector.length > 160 || !SELECTOR.test(entry.selector)) throw new Error('Swiper selector must be .swiper.<BEM-class>.');
        if (seen.has(entry.selector)) throw new Error('Duplicate Swiper selector.');
        seen.add(entry.selector);
        // PHP associative decoding can serialize an empty JSON object as [].
        const emptyConfig = Array.isArray(entry.config) && entry.config.length === 0 && Object.keys(entry.config).length === 0;
        const config = options(emptyConfig ? {} : (entry.config ?? {}));
        const defaults = {
            loop: false,
            rewind: true,
            watchSlidesProgress: true,
            speed: 250,
            autoplay: { delay: 3500, disableOnInteraction: false },
            breakpoints: {
                0: { slidesPerView: 1.25, spaceBetween: 0 },
                601: { slidesPerView: 2, spaceBetween: 0 },
                871: { slidesPerView: 3, spaceBetween: 0 },
                1024: { slidesPerView: 4, spaceBetween: 0 }
            }
        };
        const vertical = usesVertical(config);
        const mobileOnly = entry.mobile_only === undefined ? false : boolean(entry.mobile_only, 'mobile_only');
        if (vertical && mobileOnly) throw new Error('Vertical Swiper is desktop-only and cannot use mobile_only.');
        if (config.scrollbar && config.scrollbar.el !== entry.selector + ' .swiper-scrollbar') throw new Error('Scrollbar must belong to the same Swiper.');
        if (vertical) {
            config.loop = false;
            config.scrollbar = { el: entry.selector + ' .swiper-scrollbar', draggable: true, hide: false };
            config.mousewheel = { forceToAxis: true, sensitivity: 1, releaseOnEdges: false };
        }
        if (config.freeMode || config.thumbs) defaults.autoplay = false;
        if (Object.hasOwn(config, 'slidesPerView') || Object.hasOwn(config, 'breakpoints')) delete defaults.breakpoints;
        if (config.creativeEffect && config.effect !== 'creative') throw new Error('creativeEffect requires effect creative.');
        if (config.coverflowEffect && config.effect !== 'coverflow') throw new Error('coverflowEffect requires effect coverflow.');
        if (config.effect === 'coverflow') defaults.centeredSlides = true;
        const normalized = { ...defaults, ...config };
        const points = Object.values(normalized.breakpoints || {});
        // Keep spacing at one level only, preferring explicit breakpoint values.
        if (points.length && (Object.values(config.breakpoints || {}).some(point => Object.hasOwn(point, 'spaceBetween')) || !Object.hasOwn(config, 'spaceBetween'))) {
            delete normalized.spaceBetween;
            for (const point of points) point.spaceBetween = 0;
        } else {
            normalized.spaceBetween = 0;
            for (const point of points) delete point.spaceBetween;
        }
        return {
            selector: entry.selector,
            mobile_only: mobileOnly,
            config: normalized
        };
    });
    for (const entry of entries) {
        if (!entry.config.thumbs) continue;
        const target = entries.find(candidate => candidate.selector === entry.config.thumbs.swiper);
        if (!target || target === entry || target.config.thumbs) throw new Error('Thumbs must reference an independent declared slider, without cycles or chains.');
        if (entry.mobile_only || target.mobile_only || usesVertical(entry.config) || usesVertical(target.config)) throw new Error('Linked thumbnail sliders must share an always-active lifecycle.');
    }
    // Dependencies initialize before their consumers, regardless of input order.
    return entries.filter(entry => !entry.config.thumbs).concat(entries.filter(entry => entry.config.thumbs));
}

function validateMarkup(document, swipers) {
    const containers = [];
    const stack = [document];
    const classes = node => (node.attrs?.find(attr => attr.name === 'class')?.value || '').trim().split(/\s+/).filter(Boolean);
    while (stack.length) {
        const node = stack.pop();
        const names = classes(node);
        if (names.includes('swiper')) containers.push(node);
        if (names.includes('swiper-wrapper') || names.includes('swiper-slide')) {
            if (node.tagName !== 'div' || names.length !== 1) throw new Error('swiper-wrapper and swiper-slide must be standalone divs with only their library class; put BEM classes on an inner item div.');
            const parentNames = classes(node.parentNode || {});
            if (names[0] === 'swiper-wrapper' && !parentNames.includes('swiper')) throw new Error('swiper-wrapper must be a direct child of .swiper.<BEM-class>.');
            if (names[0] === 'swiper-slide') {
                if (!parentNames.includes('swiper-wrapper')) throw new Error('swiper-slide must be a direct child of .swiper-wrapper.');
                const content = (node.childNodes || []).filter(child => child.tagName || (child.nodeName === '#text' && child.value.trim()));
                if (content.length !== 1 || content[0].tagName !== 'div' || !classes(content[0]).some(name => !SWIPER_CLASSES.has(name) && CONTROL_SELECTOR.test('.' + name))) throw new Error('Each swiper-slide requires one direct inner BEM item div containing all item content.');
            }
        }
        stack.push(...(node.childNodes || []));
    }
    for (const entry of swipers) {
        const name = entry.selector.slice('.swiper.'.length);
        const matches = containers.filter(node => classes(node).includes(name));
        if (!matches.length) throw new Error(`Swiper selector has no matching container: ${entry.selector}.`);
        for (const container of matches) {
            const children = (container.childNodes || []).filter(node => node.tagName);
            const wrappers = children.filter(node => classes(node).includes('swiper-wrapper'));
            if (wrappers.length !== 1) throw new Error('Swiper container requires one direct .swiper-wrapper.');
            const slides = (wrappers[0].childNodes || []).filter(node => node.tagName);
            if (!slides.length || slides.some(node => !classes(node).includes('swiper-slide'))) throw new Error('Swiper wrapper must contain direct .swiper-slide children.');
        }
    }
}

function isExist(els) {
    return !!(els && els.length);
}

function loadYouTubeIframeAPI() {
	if (window.YT && typeof window.YT.Player === 'function') return Promise.resolve(window.YT);
	if (window.__NNYouTubeIframeAPIPromise) return window.__NNYouTubeIframeAPIPromise;

	window.__NNYouTubeIframeAPIPromise = new Promise(function (resolve, reject) {
		var timeout = setTimeout(function () {
			window.__NNYouTubeIframeAPIPromise = null;
			reject(new Error('YouTube IFrame API timeout'));
		}, 10000);
		var previousReady = window.onYouTubeIframeAPIReady;
		var script = document.querySelector('script[src*="youtube.com/iframe_api"]');

		window.onYouTubeIframeAPIReady = function () {
			if (typeof previousReady === 'function') previousReady();
			clearTimeout(timeout);
			resolve(window.YT);
		};

		if (!script) {
			script = document.createElement('script');
			script.src = 'https://www.youtube.com/iframe_api';
			script.async = true;
			script.onerror = function () {
				clearTimeout(timeout);
				window.__NNYouTubeIframeAPIPromise = null;
				reject(new Error('YouTube IFrame API load failed'));
			};
			document.head.appendChild(script);
		}
	});

	return window.__NNYouTubeIframeAPIPromise;
}

function getYouTubeVideoId(url) {
	if (!url) return '';

	var match = String(url).match(/(?:youtube(?:-nocookie)?.com\/(?:embed\/|shorts\/|watch\?(?:[^#]*&)?v=)|youtu\.be\/)([\w-]{11})/i);
	return match ? match[1] : '';
}

function prepareYouTubeIframe(iframe) {
	var source = iframe.getAttribute('src') || '';
	var videoId = iframe.getAttribute('data-youtube-id') || getYouTubeVideoId(source);
	if (!videoId) return false;

	if (!/youtube(?:-nocookie)?.com\/embed\//i.test(source)) {
		var host = /youtube-nocookie\.com/i.test(source) ? 'www.youtube-nocookie.com' : 'www.youtube.com';
		source = 'https://' + host + '/embed/' + videoId;
	}

	[
		['enablejsapi', '1'],
		['playsinline', '1'],
		['autoplay', '0'],
		['controls', '0'],
	].forEach(function (param) {
		var pattern = new RegExp('([?&])' + param[0] + '=[^&]*', 'i');
		if (pattern.test(source)) {
			source = source.replace(pattern, '$1' + param[0] + '=' + param[1]);
		} else {
			source += (source.indexOf('?') === -1 ? '?' : '&') + param[0] + '=' + param[1];
		}
	});

	if (window.location.origin && window.location.origin !== 'null' && !/[?&]origin=/i.test(source)) {
		source += '&origin=' + encodeURIComponent(window.location.origin);
	}
	if (iframe.getAttribute('src') !== source) iframe.setAttribute('src', source);
	iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
	iframe.setAttribute('allowfullscreen', '');
	return true;
}

/**
 * Khởi tạo Swiper chưa được init.
 * Dùng videoAutoplay: true hoặc { endDelay, errorDelay, slideDelay }.
 */
function initSwiper(selector, config) {
	var els = $(selector + ':not(.swiper-initialized)');
	if (!isExist(els)) return [];

	return els.toArray().map(function (el) {
		var $el = $(el);

		// --- Navigation ---
		var navigation = false;
		if (config.navigation !== false) {
			var nextEl = (config.navigation && config.navigation.nextEl) || $el.find('.swiper-button-next')[0];
			var prevEl = (config.navigation && config.navigation.prevEl) || $el.find('.swiper-button-prev')[0];
			if (nextEl && prevEl) navigation = { nextEl: nextEl, prevEl: prevEl };
		}

		// --- Pagination ---
		var pagination = false;
		if (config.pagination) {
			pagination = config.pagination === true
				? { el: $el.find('.swiper-pagination')[0], clickable: true }
				: config.pagination;
		}

		// --- Merge config, tách videoAutoplay ra (không truyền vào Swiper) ---
		var finalConfig = $.extend({}, config, { navigation: navigation, pagination: pagination });
		var videoAutoplay = finalConfig.videoAutoplay;
		delete finalConfig.videoAutoplay;

		// --- Tắt loop nếu số slide không đủ (dùng rewind thay thế) ---
		if (finalConfig.loop) {
			var slideCount = $el.find('.swiper-slide').length;
			var maxSlidesPerView = 1;
			if (finalConfig.breakpoints) {
				Object.keys(finalConfig.breakpoints).forEach(function (bp) {
					var bpConfig = finalConfig.breakpoints[bp];
					var spv = parseFloat(bpConfig.slidesPerView) || 1;
					if (spv > maxSlidesPerView) maxSlidesPerView = spv;
				});
			} else {
				maxSlidesPerView = parseFloat(finalConfig.slidesPerView) || 1;
			}

			if (slideCount <= maxSlidesPerView) {
				finalConfig.loop = false;
				finalConfig.rewind = true;
			}
		}

		var sw = new Swiper(el, finalConfig);

		// Vertical slider cần đồng nhất chiều cao sau khi ảnh/nội dung load xong.
		// Khi direction đổi theo breakpoint thì phải dọn height inline lúc chuyển sang horizontal.
		var verticalApplied = false;
		var verticalUpdateFrame = null;
		var verticalUpdateTimers = [];
		var verticalMutationObserver = null;
		var verticalResizeObserver = null;
		var verticalContentSelector = '.swiper-slide img, .swiper-slide iframe, .swiper-slide video';
		var verticalContentEventNamespace = '.nnVerticalHeight';

		function clearVerticalStyles() {
			if (!verticalApplied) return;
			verticalApplied = false;
			if (sw.slides) {
				sw.slides.forEach(function (slide) {
					slide.style.height = '';
				});
			}
			$el.css('height', '');
		}

		function updateVerticalSlideHeight() {
			if (
				!sw.slides ||
				!sw.slides.length ||
				sw.destroyed ||
				sw.params.direction !== 'vertical'
			) return;

			var maxHeight = 0;
			sw.slides.forEach(function (slide) {
				slide.style.height = 'auto';
			});

			sw.slides.forEach(function (slide) {
				var height = $(slide).outerHeight(false);
				if (height > maxHeight) maxHeight = height;
			});

			if (maxHeight <= 0) return;

			var slidesPerView = parseFloat(sw.params.slidesPerView) || 1;
			var spaceBetween = parseFloat(sw.params.spaceBetween) || 0;
			var visibleCount = Math.min(sw.slides.length, slidesPerView);
			var containerHeight = sw.params.direction == 'vertical'
				? maxHeight * visibleCount + spaceBetween * (visibleCount - 1)
				: maxHeight;

			sw.slides.forEach(function (slide) {
				slide.style.height = maxHeight + 'px';
			});
			$el.css('height', containerHeight + 'px');
			verticalApplied = true;
		}

		function scheduleVerticalSlideHeight() {
			if (sw.destroyed || verticalUpdateFrame !== null) return;

			if (typeof window.requestAnimationFrame === 'function') {
				verticalUpdateFrame = window.requestAnimationFrame(function () {
					verticalUpdateFrame = null;
					updateVerticalSlideHeight();
				});
			} else {
				verticalUpdateFrame = setTimeout(function () {
					verticalUpdateFrame = null;
					updateVerticalSlideHeight();
				}, 0);
			}
		}

		function scheduleVerticalSlideHeightAfter(delay) {
			var timer = setTimeout(function () {
				verticalUpdateTimers = verticalUpdateTimers.filter(function (item) { return item !== timer; });
				scheduleVerticalSlideHeight();
			}, delay);
			verticalUpdateTimers.push(timer);
		}

		function bindVerticalContentEvents() {
			var $content = $el.find(verticalContentSelector);
			$content
				.off(verticalContentEventNamespace)
				.on('load' + verticalContentEventNamespace + ' error' + verticalContentEventNamespace + ' loadedmetadata' + verticalContentEventNamespace + ' loadeddata' + verticalContentEventNamespace + ' canplay' + verticalContentEventNamespace, scheduleVerticalSlideHeight);

			$content.filter('img').each(function () {
				if (this.complete) scheduleVerticalSlideHeight();
			});
		}

		function observeVerticalContent() {
			if (!verticalResizeObserver || !sw.slides) return;
			verticalResizeObserver.disconnect();
			sw.slides.forEach(function (slide) {
				Array.prototype.forEach.call(slide.children, function (child) {
					verticalResizeObserver.observe(child);
				});
			});
			$el.find(verticalContentSelector).each(function () {
				verticalResizeObserver.observe(this);
			});
		}

		function cleanupVerticalHeightWatchers() {
			if (verticalUpdateFrame !== null) {
				if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(verticalUpdateFrame);
				else clearTimeout(verticalUpdateFrame);
				verticalUpdateFrame = null;
			}
			verticalUpdateTimers.forEach(function (timer) { clearTimeout(timer); });
			verticalUpdateTimers = [];
			if (verticalMutationObserver) verticalMutationObserver.disconnect();
			if (verticalResizeObserver) verticalResizeObserver.disconnect();
			$el.find(verticalContentSelector).off(verticalContentEventNamespace);
		}

		if (typeof window.ResizeObserver === 'function') {
			verticalResizeObserver = new window.ResizeObserver(function () {
				scheduleVerticalSlideHeight();
			});
		}

		if (typeof window.MutationObserver === 'function') {
			verticalMutationObserver = new window.MutationObserver(function () {
				bindVerticalContentEvents();
				observeVerticalContent();
				scheduleVerticalSlideHeight();
			});
			verticalMutationObserver.observe(el, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset'],
			});
		}

		bindVerticalContentEvents();
		observeVerticalContent();
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(scheduleVerticalSlideHeight, function () { });
		}

		// changeDirection bắn giữa chừng setBreakpoint (trước loopCreate), chỉ dọn style tại đây.
		sw.on('changeDirection', function () {
			clearVerticalStyles();
			scheduleVerticalSlideHeightAfter(0);
		});
		// breakpoint bắn cuối setBreakpoint, slide đã rebuild xong -> đo lại.
		sw.on('breakpoint', function () {
			updateVerticalSlideHeight();
			scheduleVerticalSlideHeightAfter(300);
		});
		scheduleVerticalSlideHeight();
		scheduleVerticalSlideHeightAfter(300);
		scheduleVerticalSlideHeightAfter(1000);
		scheduleVerticalSlideHeightAfter(2000);
		sw.on('slideChange', scheduleVerticalSlideHeight);
		sw.on('slideChangeTransitionEnd', scheduleVerticalSlideHeight);
		sw.on('resize', scheduleVerticalSlideHeight);
		sw.on('destroy', cleanupVerticalHeightWatchers);

		// --- Video autoplay: HTML5 video và YouTube iframe ---
		if (videoAutoplay) {
			var autoplayTimer = null;
			var videoOptions = $.extend({ endDelay: 1000, errorDelay: 1000, slideDelay: 2000 }, videoAutoplay === true ? {} : videoAutoplay);
			var youtubePlayers = [];
			var youtubeApiReady = !!(window.YT && typeof window.YT.Player === 'function');
			var youtubeApiLoading = false;
			var youtubeApiFailed = false;
			var playbackToken = 0;
			var activeMedia = [];
			var endedCount = 0;

			function clearTimer() {
				if (autoplayTimer) { clearTimeout(autoplayTimer); autoplayTimer = null; }
			}

			function scheduleNext(delay) {
				clearTimer();
				autoplayTimer = setTimeout(function () { sw.slideNext(); }, delay);
			}

			function getVisibleIndices() {
				var indices = [];
				sw.slides.forEach(function (slide, i) {
					if ($(slide).hasClass('swiper-slide-visible')) indices.push(i);
				});
				// Fallback nếu watchSlidesProgress chưa update kịp.
				if (!indices.length) {
					var spv = Math.round(parseFloat(sw.params.slidesPerView) || 1);
					for (var i = 0; i < spv && sw.slides[sw.activeIndex + i]; i++) indices.push(sw.activeIndex + i);
				}
				return indices;
			}

			function findYouTubePlayer(iframe) {
				for (var i = 0; i < youtubePlayers.length; i++) {
					if (youtubePlayers[i].iframe === iframe) return youtubePlayers[i];
				}
				return null;
			}

			function createYouTubePlayer(iframe, slideIndex) {
				var existing = findYouTubePlayer(iframe);
				if (existing || !youtubeApiReady) return existing;

				var entry = { iframe: iframe, player: null, slideIndex: slideIndex, ready: false, activeToken: 0 };
				youtubePlayers.push(entry);

				try {
					entry.player = new YT.Player(iframe, {
						events: {
							onReady: function (event) {
								entry.player = event.target;
								entry.ready = true;
								handleSlide();
							},
							onStateChange: function (event) {
								if (event.data === YT.PlayerState.ENDED) completeMedia(entry.media);
							},
							onError: function () {
								if (entry.activeToken === playbackToken) scheduleNext(videoOptions.errorDelay);
							},
						},
					});
				} catch (error) {
					entry.error = true;
					youtubeApiFailed = true;
				}
				return entry;
			}

			function ensureYouTubePlayers() {
				var hasYouTube = false;
				sw.slides.forEach(function (slide, slideIndex) {
					var iframe = slide.querySelector('iframe');
					if (!iframe || !prepareYouTubeIframe(iframe)) return;
					hasYouTube = true;
					createYouTubePlayer(iframe, slideIndex);
				});
				return hasYouTube;
			}

			function detachHtml5Handlers() {
				sw.slides.forEach(function (slide) {
					var video = slide.querySelector('video');
					if (!video) return;
					if (video.__nnSwiperEndedHandler) {
						video.removeEventListener('ended', video.__nnSwiperEndedHandler);
						video.__nnSwiperEndedHandler = null;
					}
					if (video.__nnSwiperErrorHandler) {
						video.removeEventListener('error', video.__nnSwiperErrorHandler);
						video.__nnSwiperErrorHandler = null;
					}
				});
			}

			function resetInactiveVideos(visibleIndices) {
				sw.slides.forEach(function (slide, slideIndex) {
					if (visibleIndices.indexOf(slideIndex) === -1) {
						var video = slide.querySelector('video');
						if (video) { video.pause(); video.currentTime = 0; }
					}
				});
				youtubePlayers.forEach(function (entry) {
					if (visibleIndices.indexOf(entry.slideIndex) === -1) {
						entry.activeToken = 0;
						if (entry.ready && entry.player) {
							entry.player.pauseVideo();
							entry.player.seekTo(0, true);
						}
					}
				});
			}

			function completeMedia(media) {
				if (!media || media.activeToken !== playbackToken || media.ended) return;
				media.ended = true;
				endedCount++;
				if (endedCount >= activeMedia.length) scheduleNext(videoOptions.endDelay);
			}

			function handleSlide() {
				clearTimer();
				detachHtml5Handlers();
				playbackToken++;
				activeMedia = [];
				endedCount = 0;

				var visibleIndices = getVisibleIndices();
				var hasYouTube = ensureYouTubePlayers();
				resetInactiveVideos(visibleIndices);
				var pendingYouTube = false;

				visibleIndices.forEach(function (slideIndex) {
					var slide = sw.slides[slideIndex];
					var video = slide && slide.querySelector('video');
					if (video) activeMedia.push({ video: video, activeToken: playbackToken, ended: false, type: 'html5' });

					var iframe = slide && slide.querySelector('iframe');
					if (iframe && prepareYouTubeIframe(iframe)) {
						var player = findYouTubePlayer(iframe);
						if (!player || !player.ready) pendingYouTube = true;
						else {
							var media = { player: player, activeToken: playbackToken, ended: false, type: 'youtube' };
							player.media = media;
							activeMedia.push(media);
						}
					}
				});

				if (pendingYouTube && hasYouTube && !youtubeApiReady) {
					if (youtubeApiFailed) {
						if (!activeMedia.length) scheduleNext(videoOptions.errorDelay);
						return;
					}
					if (!youtubeApiLoading) {
						youtubeApiLoading = true;
						loadYouTubeIframeAPI().then(function () {
							youtubeApiReady = true;
							youtubeApiLoading = false;
							handleSlide();
						}).catch(function () {
							youtubeApiLoading = false;
							youtubeApiFailed = true;
							if (!activeMedia.length) scheduleNext(videoOptions.errorDelay);
						});
					}
					return;
				}

				if (pendingYouTube && !activeMedia.length && !youtubeApiFailed) return;
				if (pendingYouTube && !activeMedia.length) {
					scheduleNext(videoOptions.errorDelay);
					return;
				}
				if (!activeMedia.length) {
					scheduleNext(videoOptions.slideDelay);
					return;
				}

				activeMedia.forEach(function (media) {
					if (media.type === 'youtube') {
						media.player.activeToken = playbackToken;
						media.player.player.mute();
						media.player.player.seekTo(0, true);
						media.player.player.playVideo();
					} else {
						var video = media.video;
						var onEnded = function () { completeMedia(media); };
						var onError = function () {
							if (media.activeToken === playbackToken) scheduleNext(videoOptions.errorDelay);
						};
						video.__nnSwiperEndedHandler = onEnded;
						video.addEventListener('ended', onEnded, { once: true });
						video.__nnSwiperErrorHandler = onError;
						video.addEventListener('error', onError, { once: true });
						video.currentTime = 0;
						var playPromise = video.play();
						if (playPromise && playPromise.catch) playPromise.catch(onError);
					}
				});
			}

			sw.on('slideChangeTransitionEnd', handleSlide);
			var hasYouTube = ensureYouTubePlayers();
			if (hasYouTube && !youtubeApiReady) {
				youtubeApiLoading = true;
				loadYouTubeIframeAPI().then(function () {
					youtubeApiReady = true;
					youtubeApiLoading = false;
					handleSlide();
				}).catch(function () {
					youtubeApiLoading = false;
					youtubeApiFailed = true;
					scheduleNext(videoOptions.errorDelay);
				});
			}
			handleSlide();
		}

		return sw;
	});
}

function initializePreview(entries) {
    var states = entries.map(function (entry) { return { entry: entry, instances: [] }; });
    function sync() {
        states.forEach(function (state) {
            var vertical = state.entry.config.direction === 'vertical' || Object.keys(state.entry.config.breakpoints || {}).some(function (point) {
                return state.entry.config.breakpoints[point].direction === 'vertical';
            });
            if (vertical ? window.innerWidth > 600 : (!state.entry.mobile_only || window.innerWidth <= 600)) {
                if (!state.instances.length) {
                    var config = state.entry.config;
                    if (config.thumbs) {
                        var target = states.find(function (candidate) { return candidate.entry.selector === config.thumbs.swiper; });
                        var thumbnail = target && target.instances[0];
                        if (!thumbnail || thumbnail.destroyed) return;
                        config = $.extend({}, config, { thumbs: $.extend({}, config.thumbs, { swiper: thumbnail }) });
                    }
                    state.instances = initSwiper(state.entry.selector, config);
                }
                state.instances.forEach(function (sw) {
                    if (!sw.destroyed) {
                        sw.setBreakpoint();
                        sw.update();
                    }
                });
            } else {
                state.instances.forEach(function (sw) { if (!sw.destroyed) sw.destroy(true, true); });
                state.instances = [];
            }
        });
    }
    sync();
    window.addEventListener('resize', sync);
    return function () {
        window.removeEventListener('resize', sync);
        states.forEach(function (state) {
            state.instances.forEach(function (sw) { if (!sw.destroyed) sw.destroy(true, true); });
            state.instances = [];
        });
    };
}

function previewBridge(functions) {
    return 'window.figmaSwiperPreview = function (frameWindow, entries, jquery, ParentSwiper) {\n'
        + '    var window = frameWindow;\n    var document = window.document;\n'
        + '    var $ = function (selector) { return jquery(selector, document); };\n    $.extend = jquery.extend;\n'
        + '    function Swiper(el, config) {\n'
        + '        var options = $.extend({}, config, { init: false, breakpointsBase: "container" });\n'
        + '        if (config.scrollbar && typeof config.scrollbar.el === "string") {\n'
        + '            options.scrollbar = $.extend({}, config.scrollbar, { el: el.querySelector(".swiper-scrollbar") });\n'
        + '        }\n'
        + '        var sw = new ParentSwiper(el, options);\n'
        + '        sw.getBreakpoint = function (breakpoints) {\n'
        + '            var selected = "max";\n'
        + '            Object.keys(breakpoints || {}).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (point) {\n'
        + '                if (/^(0|[1-9][0-9]{0,4})$/.test(point) && Number(point) <= window.innerWidth) selected = point;\n'
        + '            });\n'
        + '            return selected;\n'
        + '        };\n'
        + '        if (config.init !== false) sw.init();\n'
        + '        return sw;\n    }\n\n'
        + functions + '\n' + initializePreview.toString() + '\n'
        + '    return initializePreview(entries);\n};\n';
}

function validateDirectory(directory, entries) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('directory must be a source directory.');
    const root = path.resolve(directory);
    const filename = path.join(root, 'index.html');
    // Do not follow links in any component, including a junction parent.
    let current = filename;
    while (true) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Swiper source may not contain symlinks.');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    if (!fs.statSync(root).isDirectory()) throw new Error('directory must be a source directory.');
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Swiper HTML exceeds its source byte budget.');
    const html = fs.readFileSync(filename, 'utf8');
    if ((html.match(/</g) || []).length > 30000) throw new Error('Swiper HTML exceeds its node budget.');
    const parse5 = require('parse5');
    validateMarkup(parse5.parse(html), entries);
}

function sourceValue(value) {
    if (typeof value === 'string') return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (Array.isArray(value)) return '[' + value.map(sourceValue).join(', ') + ']';
    if (value && typeof value === 'object') return '{ ' + Object.entries(value).map(([key, item]) => `${key}: ${sourceValue(item)}`).join(', ') + ' }';
    return JSON.stringify(value);
}

function configSource(config, indent, thumbnail = null) {
    const lines = ['{'];
    let group = [];
    function flush() {
        if (group.length) lines.push(indent + '    ' + group.join(', ') + ',');
        group = [];
    }
    for (const [key, value] of Object.entries(config)) {
        if (!value || typeof value !== 'object') {
            group.push(`${key}: ${sourceValue(value)}`);
            if (group.length === 3) flush();
            continue;
        }
        flush();
        if (key === 'autoplay') lines.push(`${indent}    ${key}: ${sourceValue(value)},`);
        else {
            lines.push(`${indent}    ${key}: {`);
            for (const [child, item] of Object.entries(value)) {
                const rendered = key === 'thumbs' && child === 'swiper' ? thumbnail : sourceValue(item);
                lines.push(`${indent}        ${child}: ${rendered},`);
            }
            lines.push(indent + '    },');
        }
    }
    flush();
    lines.push(indent + '}');
    return lines.join('\n');
}

function scripts(request) {
    try {
        const entries = normalize(request?.swipers);
        if (request && Object.hasOwn(request, 'directory')) validateDirectory(request.directory, entries);
        const functions = [isExist, loadYouTubeIframeAPI, getYouTubeVideoId, prepareYouTubeIframe, initSwiper].map(fn => fn.toString()).join('\n\n') + '\n';
        const lines = ['$(document).ready(function () {'];
        const referenced = new Set(entries.filter(entry => entry.config.thumbs).map(entry => entry.config.thumbs.swiper));
        const variable = entry => `swiper${entries.indexOf(entry)}`;
        for (const [index, entry] of entries.entries()) {
            const vertical = usesVertical(entry.config);
            const condition = vertical ? 'window.innerWidth > 600' : (entry.mobile_only ? 'window.innerWidth <= 600' : null);
            const indent = condition ? '        ' : '    ';
            const target = entry.config.thumbs && entries.find(item => item.selector === entry.config.thumbs.swiper);
            const config = configSource(entry.config, indent, target ? variable(target) : null);
            const prefix = referenced.has(entry.selector) ? `let ${variable(entry)} = ` : '';
            const suffix = referenced.has(entry.selector) ? '[0]' : '';
            if (index) lines.push('');
            if (condition) lines.push(`    if (${condition}) {`);
            lines.push(`${indent}${prefix}initSwiper(${sourceValue(entry.selector)}, ${config})${suffix};`);
            if (condition) lines.push('    }');
        }
        lines.push('});', '');
        return { ok: true, functions, apps: lines.join('\n'), bridge: previewBridge(functions), swipers: entries, ...URLS };
    } catch (error) {
        return { ok: false, errors: [error.message] };
    }
}

module.exports = { scripts, normalize, usesVertical, validateMarkup, SWIPER_CLASSES, URLS };
