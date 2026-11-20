(function (b) {
	var r = document.documentElement, now = Date.now(), off = false;
	try { off = b.hasAttribute("data-dismissible") && localStorage.getItem("announcement:" + b.dataset.version) === "closed"; } catch (e) {}
	var on = !off && !(b.dataset.from && now < +b.dataset.from) && !(b.dataset.to && now > +b.dataset.to);
	b.hidden = !on;
	r.classList.toggle("has-announcement", on);
	if (!on) return;
	var h = b.offsetHeight;
	r.style.setProperty("--announce-h", h + "px");
	r.style.setProperty("--announce-offset", (b.hasAttribute("data-sticky") ? h : Math.max(0, h - scrollY)) + "px");
})(document.currentScript.previousElementSibling);
