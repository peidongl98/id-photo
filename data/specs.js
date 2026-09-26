/* 证件照规格库 —— 纯数据，无依赖
   faceRatio：人脸（头顶到下巴）占画面高度的比例
   centerY  ：脸部中心在画面垂直方向的位置（0=顶，1=底）
   topMargin：头顶到画面上边缘的最小留白比例 */
(function () {
  'use strict';

  var D = { faceRatio: 0.65, centerY: 0.42, topMargin: 0.05 };

  function s(o) {
    o.faceRatio = o.faceRatio || D.faceRatio;
    o.centerY = o.centerY || D.centerY;
    o.topMargin = o.topMargin == null ? D.topMargin : o.topMargin;
    return o;
  }

  var SPECS = [
    /* ---------- 中国常用 ---------- */
    s({ id:'one-inch',      name:'一寸',        category:'中国常用', width_mm:25, height_mm:35, width_px:295,  height_px:413,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'简历、工作证、部分报名表' }),
    s({ id:'small-one-inch',name:'小一寸',      category:'中国常用', width_mm:22, height_mm:32, width_px:260,  height_px:378,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'学生证、部分表格' }),
    s({ id:'big-one-inch',  name:'大一寸',      category:'中国常用', width_mm:33, height_mm:48, width_px:390,  height_px:567,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'毕业证、职称申报' }),
    s({ id:'two-inch',      name:'二寸',        category:'中国常用', width_mm:35, height_mm:49, width_px:413,  height_px:579,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'简历、公务员报名' }),
    s({ id:'small-two-inch',name:'小二寸',      category:'中国常用', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'护照、通行证辅助' }),
    s({ id:'big-two-inch',  name:'大二寸',      category:'中国常用', width_mm:35, height_mm:53, width_px:413,  height_px:626,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'部分资格证' }),
    s({ id:'id-card',       name:'身份证',      category:'中国常用', width_mm:26, height_mm:32, width_px:358,  height_px:441,  bg_color:'#FFFFFF', faceRatio:0.67, centerY:0.42, topMargin:0.05, note:'居民身份证' }),
    s({ id:'driver-license',name:'驾驶证',      category:'中国常用', width_mm:22, height_mm:32, width_px:260,  height_px:378,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'驾驶证申领、换证' }),
    s({ id:'cn-passport',   name:'中国护照',    category:'中国常用', width_mm:33, height_mm:48, width_px:390,  height_px:567,  bg_color:'#FFFFFF', faceRatio:0.67, centerY:0.42, topMargin:0.05, note:'普通护照申请' }),
    s({ id:'chsi',          name:'高考/学信网', category:'中国常用', width_mm:null, height_mm:null, width_px:480, height_px:640, bg_color:'#64C5FF', faceRatio:0.65, centerY:0.45, topMargin:0.06, note:'学信网、阳光高考，浅蓝底' }),

    /* ---------- 签证 ---------- */
    s({ id:'us-visa',       name:'美国签证',    category:'签证', width_mm:51, height_mm:51, width_px:600,  height_px:600,  bg_color:'#FFFFFF', faceRatio:0.60, centerY:0.45, topMargin:0.08, note:'2×2 英寸，600–1200px' }),
    s({ id:'schengen-visa', name:'申根签证',    category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.70, centerY:0.42, topMargin:0.05, note:'欧洲申根国通用' }),
    s({ id:'jp-visa',       name:'日本签证',    category:'签证', width_mm:45, height_mm:45, width_px:531,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.45, note:'45×45mm 正方形' }),
    s({ id:'kr-visa',       name:'韩国签证',    category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'35×45mm' }),
    s({ id:'uk-visa',       name:'英国签证',    category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'35×45mm' }),
    s({ id:'ca-visa',       name:'加拿大签证',  category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'35×45mm' }),
    s({ id:'au-visa',       name:'澳大利亚签证',category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'35×45mm' }),
    s({ id:'sg-visa',       name:'新加坡签证',  category:'签证', width_mm:35, height_mm:45, width_px:413,  height_px:531,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'35×45mm' }),
    s({ id:'in-evisa',      name:'印度电子签证',category:'签证', width_mm:null, height_mm:null, width_px:700, height_px:700,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.45, note:'700×700px' }),

    /* ---------- 其他 ---------- */
    s({ id:'three-inch',    name:'三寸',        category:'其他', width_mm:55, height_mm:84,  width_px:650,  height_px:992,  bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'大尺寸冲印' }),
    s({ id:'four-inch',     name:'四寸',        category:'其他', width_mm:76, height_mm:102, width_px:898,  height_px:1205, bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'大尺寸冲印' }),
    s({ id:'five-inch',     name:'五寸',        category:'其他', width_mm:89, height_mm:127, width_px:1050, height_px:1500, bg_color:'#FFFFFF', faceRatio:0.65, centerY:0.42, note:'大尺寸冲印' })
  ];

  var BG_COLORS = [
    { id:'white', name:'白色',       hex:'#FFFFFF', note:'通用、护照、签证' },
    { id:'blue',  name:'蓝色',       hex:'#438EDB', note:'简历、职称、社保' },
    { id:'red',   name:'红色',       hex:'#FF0000', note:'部分资格证、结婚证' },
    { id:'gray',  name:'浅灰',       hex:'#F0F0F0', note:'浅色背景' },
    { id:'chsi',  name:'学信网浅蓝', hex:'#64C5FF', note:'RGB(100,197,255)' }
  ];

  window.IDP = window.IDP || {};
  window.IDP.SPECS = SPECS;
  window.IDP.CATEGORIES = ['中国常用', '签证', '其他', '自定义'];
  window.IDP.BG_COLORS = BG_COLORS;
  window.IDP.SPEC_DEFAULTS = D;
})();
