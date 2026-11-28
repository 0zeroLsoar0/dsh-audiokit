# 涓撲笟鍓緫杞欢浜掓搷浣滐紙audio_daw 鎵╁睍锛?
鏈枃璁板綍 `audio_daw` 鏂板鐨勫洓涓氦鎹㈡牸寮忥細**AAF**銆?*OMF**銆?*OpenTimelineIO (.otio)**銆?*FCP7 xmeml XML**锛?姣忎釜鏍煎紡鐨勭湡瀹炶兘鍔涜竟鐣屻€佸鍏ユ楠ゃ€佸瓧娈垫槧灏勩€佸凡鐭ラ檺鍒朵笌鍚庣画宸ヤ綔閲忋€?
涓€鍙ヨ瘽缁撹锛堥伩鍏嶈鍒わ級锛?
| 鏍煎紡 | 鐜板湪鑳藉仛浠€涔?| Pro Tools | DaVinci Resolve | Premiere Pro |
|---|---|---|---|---|
| **otio** | 瀹屾暣鍙敤锛氭牱渚嬪凡鐢?opentimelineio 0.18.1 鐙珛璇诲洖锛屾椂闂磋酱閫愭牱鏈噯纭?| 涓嶈兘瀵煎叆 | **鑳?*锛?8+锛孎ile > Import > Timeline锛?| 闇€瑁?OTIO adapter 鎻掍欢锛涜浜嗗氨鑳?|
| **xmeml** | 瀹屾暣鍙敤锛氭牱渚嬪凡鐢?Python ElementTree 鐙珛瑙ｆ瀽锛屽抚绾у噯纭€佸甫澧炵泭 | 涓嶈兘瀵煎叆锛圥ro Tools 涓嶈 FCP7 XML锛?| **鑳?*锛團ile > Import Timeline锛孎CP7 XML锛?| **鑳?*锛團ile > Import锛孎inal Cut Pro XML锛?|
| **aaf** | **缁撴瀯瀛愰泦**锛氬鍣ㄣ€佸璞″浘銆佸睘鎬х紪鐮併€佹椂闂磋酱銆佸祵鍏?PCM 閮芥槸鐪熺殑锛?*缂?MetaDictionary锛孉AF SDK 绯昏蒋浠朵細鍦ㄨВ鏋愬瓧鍏歌繖涓€姝ユ嫆缁?* | 鎷掔粷锛堣绗?1.4 鑺傜殑瀹炴祴璇佹嵁锛?| 鎷掔粷 | 涓嶆敮鎸?AAF |
| **omf** | **楠ㄦ灦**锛欳FB 瀹瑰櫒 + `OMFI:HEADER` 璇存槑娴?+ JSON 娓呭崟锛?*涓嶆槸 OMF 鏂囨。锛孉vid 蹇呮嫆缁?* | 鎷掔粷 | 鎷掔粷 | 涓嶆敮鎸?OMF |

> 閲嶈锛?*涓嶈**鎶?`aaf` 鎻忚堪鎴?Pro Tools 鍙敤鐨?AAF"銆傚畠鏄竴浠界湡瀹炲鍣ㄩ噷鐨勭湡瀹?AAF 瀵硅薄鍥惧姞涓婁竴澶?> 鏄庣‘缂哄け鐨勫瓧鍏稿眰锛岀敤浜庡悗缁帴缁紑鍙戯紝涓嶅彲浜や粯銆傜湡姝ｈ兘浜ゅ埌鍓緫杞欢鎵嬮噷鐨勶紝鏄?`otio` 鍜?`xmeml`銆?
---

## 1. AAF锛坄lib/aaf.js` + `lib/cfb.js`锛?
### 1.1 宸插疄鐜扮殑缁撴瀯锛堥兘鏄啓鍑烘潵鐨勭湡瀹炲瓧鑺傦級

AAF 鏂囦欢鏄?MS-CFB锛堢粨鏋勫寲瀛樺偍锛夊鍚堟枃妗ｏ紝`lib/cfb.js` 浠庨浂瀹炵幇浜嗚瀹瑰櫒锛堥浂渚濊禆锛夛細

- CFB v3锛?12 瀛楄妭鎵囧尯锛夈€丗AT銆佽糠浣犳祦锛?4096 瀛楄妭鐨勬祦锛? MiniFAT銆佽秴杩?109 涓?FAT 鎵囧尯鏃剁殑 DIFAT锛?- 姣忎釜瀛樺偍锛坰torage锛夌殑瀛愰」鏄竴妫电孩榛戞爲锛屾寜 CFB 瑙勫畾鐨勯『搴忥紙**鍏堢煭鍚庨暱锛屽悓闀垮拷鐣ュぇ灏忓啓**锛夋帓搴忋€?  鎻掑叆鐢ㄦ暀绉戜功寮忕孩榛戞彃鍏ワ紙CLRS锛氭柊鑺傜偣涓虹孩锛岀埗鏌撻粦銆佺鐖舵煋绾紝蹇呰鏃朵笂婧紱鏃嬭浆鍙敼鎸囬拡銆佷笉鏀归鑹诧紝
  骞舵妸鎻愬崌鍚庣殑鑺傜偣鎺ュ洖鐖惰妭鐐圭殑瀛愭寚閽堬級锛屽洜姝ゆ牴涓洪粦銆佹棤绾㈢孩杈广€佸悇璺緞榛戦珮涓€鑷达紝n 涓瓙椤圭殑娣卞害鏈夌晫浜?  `2路log2(n)+2`銆傚瓙椤规寜鍚嶅瓧鏈夊簭閫愪釜鎻掑叆鏄簩鍙夋悳绱㈡爲鐨勬渶鍧忔儏鍐碉紝鎵€浠?鐪嬭捣鏉ユ湁搴?涓嶅锛屽繀椤荤湡姝ｉ噸鏂板钩琛★紱
  娴嬭瘯瀵?1/2/3/7/15 涓瓙椤圭洿鎺ヨВ鐮佸師濮嬬洰褰曢」楠岃瘉杩欑粍涓嶅彉閲忥紙瀹炴祴娣卞害 1/2/2/4/6锛夛紝骞跺 AAF 閲屾渶瀹界殑
  ContentStorage锛?5 涓?cue 鏃?49 涓瓙椤癸級鏂█娣卞害 9 鈮?13.23锛?- 璇诲彇绔敮鎸?v3/v4锛岄€愰」鏍￠獙绛惧悕銆佸瓧鑺傚簭銆佹墖鍖轰綅绉汇€丗AT 閾撅紙鏃犵幆銆佷笉瓒婄晫锛夈€佽糠浣犳祦杈圭晫銆佺洰褰曟爲鏈夊簭鎬э紱
  `readCompoundFile` 鍙﹀杩斿洖鍘熷鐩綍椤癸紙`left`/`right`/`child`/`color`锛夛紝渚夸簬妫€鏌ユ爲褰㈣€屼笉鍙槸椤哄簭锛?- 纭畾鎬э細涓嶈鏃堕挓銆佷笉鐢ㄩ殢鏈烘暟锛屾椂闂存埑鍐?0锛屽悓涓€妫垫爲姘歌繙鍚屽瓧鑺傘€?
鍦ㄥ鍣ㄤ箣涓婏紝`lib/aaf.js` 鍐欑殑瀵硅薄鍥撅紙绫?ID 鍙栬嚜 AAF 娉ㄥ唽琛紝灞炴€?ID 涓鸿鑼冨唴缃?PID锛夛細

```
/                                   Root
  properties                        Root 鐨勫睘鎬ф祦锛?x0001鈫扢etaDictionary锛?x0002鈫扝eader锛?  referenced properties             寮卞紩鐢ㄨ〃锛坲8 0x4c, u16 璺緞鏁? u32 pid 鏁? pid 璺緞浠?0 缁撳熬锛?  MetaDictionary-1                  鍏冨瓧鍏稿璞?鈥斺€?鍙湁瀵硅薄澶栧３锛屾病鏈夌被瀹氫箟锛堣 1.4锛?  Header-2/                         Header锛堝瓧鑺傚簭 II銆佺増鏈?1.2銆佸璞℃ā鍨嬬増鏈?1銆佹搷浣滄ā寮?OP1a锛?    IdentificationList-3b06{0}      浜у搧鏍囪瘑锛坉sh-audiokit / 0.5.10 / 骞冲彴 / 鐢熸垚 UUID锛?    Dictionary-3b04/                瀛楀吀锛欴ataDef_Sound/Data/Timecode銆丆ontainerDef_AAF/RIFFWAVE
    Content-3b03/                   ContentStorage
      Mobs-1901{0}                  CompositionMob = 鏃堕棿杞达紙姣忔潯 lane 涓€涓?TimelineMobSlot锛?      Mobs-1901{1..n}               MasterMob锛堟瘡涓?cue 涓€涓級+ SourceMob锛堟瘡涓?cue 涓€涓紝甯?PCMDescriptor锛?      EssenceData-1902{i}           宓屽叆鐨?PCM锛堝師濮嬪抚锛屾棤 RIFF 澶达級锛屽睘鎬?0x2702 鎸囧悜娴?Data-2702
```

EssenceData 鐨勫綊灞炴槸鏄惧紡鐨勪竴鏉￠摼锛屼笉鏄袱涓簰涓嶇浉骞茬殑寮曠敤锛歚0x2701 MobID` 鎸囧悜**甯?PCMDescriptor 鐨?SourceMob**锛堜笉鏄?MasterMob锛夛紝鑰?SourceMob 鑷韩 slot 閲岀殑 SourceClip 鐢?*鑷韩 UMID** 涓?`length` = 濯掍綋
甯ф暟锛堜笉鍐嶆槸鍏?0 UMID + 闀垮害 0锛夈€傛椂闂磋酱涓€渚ф槸 CompositionMob 鈫?MasterMob 鈫?SourceMob锛岃鏂欎竴渚ф槸
EssenceData 鈫?SourceMob锛屼袱澶磋惤鍦ㄥ悓涓€涓?mob 涓娿€?
灞炴€ф祦鏍煎紡锛堜笌 AAF 瀛樺偍瀵硅薄瑙勮寖涓€鑷达級锛?
```
u8  0x4c            灏忕鏍囪
u8  32              灞炴€ф祦鐗堟湰
u16 鏉＄洰鏁?鏉＄洰 脳 u16 pid, u16 瀛樺偍鏍煎紡, u16 鏁版嵁闀垮害
鏁版嵁锛堟寜鏉＄洰椤哄簭绱ф帓锛?```

瀛樺偍鏍煎紡鍊硷細`0x82` 鏁版嵁銆乣0x22` 寮哄紩鐢ㄣ€乣0x32`/`0x3a` 寮哄紩鐢ㄥ悜閲?闆嗗悎銆乣0x42` 娴佸睘鎬с€乣0x02`锛堜互鍙婂急寮曠敤锛?寮卞紩鐢ㄣ€傚己寮曠敤瀛樼殑鏄?*鐩爣瀛樺偍鐨勫悕瀛?*锛圲TF-16LE锛屽惈缁撳熬 NUL锛夛紱鍚戦噺鍦ㄥ睘鎬ф祦閲屽瓨绱㈠紩娴佸悕锛岀湡姝ｇ殑寮曠敤鍦?`<鍚嶅瓧> index` 娴侀噷锛坄u32 鏁伴噺, u32 涓嬩竴涓┖閿? u32 鏈€鍚庝竴涓┖閿? u32 閿甗]`锛夛紝瀛愬璞″懡鍚嶄负 `<鍚嶅瓧>{<閿?hex>}`銆?寮卞紩鐢ㄥ瓨 `u16 琛ㄤ笅鏍? u16 閿?pid, u8 閿暱, 閿甡銆?
Mob / Slot / Component / Descriptor 鐨?PID 涓庣紪鐮侊紙鏉ヨ嚜 AAF 瀵硅薄瑙勮寖鐨勫唴缃睘鎬э紝闈炶嚜閫狅級锛?
| 瀵硅薄 | PID | 缂栫爜 |
|---|---|---|
| MobID | 0x4401 | 32 瀛楄妭 SMPTE 330 鍩烘湰 UMID锛?2 瀛楄妭 UL + 0x13 + 3 瀛楄妭瀹炰緥鍙?+ 16 瀛楄妭绱犳潗鍙凤級 |
| Mob.Name / CreationTime / LastModified | 0x4402 / 0x4404 / 0x4405 | UTF-16LE+NUL / 8 瀛楄妭鏃ユ湡缁撴瀯 |
| Mob.Slots / UsageCode | 0x4403 / 0x4408 | 寮哄紩鐢ㄥ悜閲?/ 16 瀛楄妭 AUID |
| SourceMob.EssenceDescription | 0x4701 | 寮哄紩鐢?鈫?PCMDescriptor |
| MobSlot.SlotID / SlotName / Segment | 0x4801 / 0x4802 / 0x4803 | u32 / UTF-16LE / 寮哄紩鐢?|
| TimelineMobSlot.EditRate / Origin | 0x4b01 / 0x4b02 | 鏈夌悊鏁帮紙u32 鍒嗗瓙, u32 鍒嗘瘝锛? i64 |
| Component.DataDefinition / Length | 0x0201 / 0x0202 | 寮卞紩鐢?/ i64 |
| Sequence.Components | 0x1001 | 寮哄紩鐢ㄥ悜閲?|
| SourceClip.SourceID / SlotID / Start | 0x1101 / 0x1102 / 0x1201 | UMID / u32 / i64 |
| PCMDescriptor | 0x3001, 0x3002, 0x3d01, 0x3d03, 0x3d07, 0x3d09, 0x3d0a | 閲囨牱鐜?鏈夌悊鏁?銆佸抚鏁?i64)銆侀噺鍖栦綅娣便€侀煶棰戦噰鏍风巼銆佸０閬撴暟銆佸钩鍧囧瓧鑺傜巼銆佸潡瀵归綈 |
| EssenceData.MobID / Data | 0x2701 / 0x2702 | UMID / 娴佸睘鎬?|

鏃堕棿杞存槧灏勶細cue 鍏堟寜閲嶅彔鍏崇郴**鎵撳寘鎴愭渶灏?lane**锛坄lib/timeline.js` 鐨勫尯闂村垎鍓茶椽蹇冿級锛屾瘡鏉?lane 涓€涓?`TimelineMobSlot`锛屾涓鸿 lane 鐨?`Sequence`锛岀粍浠跺簭鍒楁槸 `Filler(闂撮殭) + SourceClip(鐗囨)`锛岀紪杈戠巼 = 閲囨牱鐜?锛堥粯璁ゅ彇绗竴鏉¤宓屽叆濯掍綋鐨勯噰鏍风巼锛夛紝鍥犳 `at`/`duration` 鎹㈢畻鎴愰噰鏍风偣鍚?*閫愭牱鏈簿纭?*锛堟祴璇曞疄娴嬭宸?0 碌s锛夈€?姣忎釜 cue 杩樻湁涓€鏉¤嚜娲界殑寮曠敤閾撅細CompositionMob 鐨勬椂闂磋酱 鈫?MasterMob 鈫?SourceMob锛堝甫 PCMDescriptor锛夛紱
SourceMob 鑷韩 slot 鐨?SourceClip 鐢ㄨ嚜韬?UMID銆乣length` = 濯掍綋甯ф暟锛孍ssenceData 鐨?`MobID`锛?x2701锛変篃鎸囧悜
杩欎釜 SourceMob锛屾墍浠ユ弿杩扮闀垮害銆乻lot 闀垮害涓庡祵鍏ュ瓧鑺傛暟涓夊涓€鑷淬€俙parseAaf` 璇诲洖鏃舵柇瑷€鏁存潯閾?锛坄validateAafGraph`锛夛細essence 蹇呴』鎸囧悜甯?descriptor 鐨?SourceMob銆丼ourceMob 鐨?slot 闀垮害蹇呴』绛変簬 descriptor
闀垮害銆佹ā鍨嬮噷浠讳綍寮曠敤閮戒笉鍏佽鍑虹幇鍏?0 UMID銆侲ssenceData 閲屾槸**鍘熷浜ら敊 PCM 甯?*锛堜笉鏄?RIFF 鏂囦欢锛夈€?
纭畾鎬э細UMID 鐨勭礌鏉愬彿 = `SHA-256("dsh-audiokit/aaf/1:<seed>")` 鍓?16 瀛楄妭锛涙棩鏈熷浐瀹?2025-01-01T00:00:00锛?鎵€鏈夊悕瀛楃敱 `灞炴€у悕-PID` 娲剧敓銆傚悓涓€璇锋眰涓ゆ璋冪敤瀛楄妭瀹屽叏鐩稿悓锛堟祴璇曟柇瑷€锛夈€?
### 1.2 宸叉敮鎸?/ 鏈敮鎸佸瓧娈?
| 杈撳叆瀛楁 | AAF 杈撳嚭 | 璇存槑 |
|---|---|---|
| name | 鉁?Mob.Name銆丼lotName | 瀹屾暣淇濈暀 |
| path | 鈿狅笍 浠呬綔涓虹绾挎爣璁扮殑璇箟鏉ユ簮 | 宓屽叆 PCM 鍚?AAF 涓嶉渶瑕佸閮ㄨ矾寰勶紱鏈祵鍏ョ殑 cue 鏄?绂荤嚎鐗囨"锛堟湁闀垮害鏃犺鏂欙級 |
| at / duration | 鉁?閲囨牱鐐圭簿纭?| 缂栬緫鐜?= 閲囨牱鐜?|
| gainDb | 鉂?| 闇€瑕?`OperationGroup` + 鐢靛钩鍙傛暟瀵硅薄锛屾湰瀛愰泦鏈疄鐜帮紙OTIO/xmeml/rpp 鏈夛級 |
| fadeIn / fadeOut | 鉂?| AAF 鐨勬贰鍏ユ贰鍑烘槸 `OperationGroup`/杞満锛屾湭瀹炵幇 |

### 1.3 宓屽叆 PCM 鐨勭害鏉?
- 鍙祵鍏?*鏁存暟 PCM**锛?/16/24/32 bit锛夛紱娴偣鎴栧帇缂?wav 浼氳闄嶇骇涓虹绾跨墖娈靛苟鍦ㄧ粨鏋滈噷璇存槑鍘熷洜锛?  鑰屼笉鏄敤閿欒鐨勬弿杩扮纭锛坄PCMDescriptor` 鎻忚堪鐨勬槸鏁村瀷鏍锋湰锛夈€?- 鎬诲祵鍏ラ噺榛樿涓婇檺 64 MiB锛坄maxEmbedBytes` 鍙皟锛夛紱`embed: false` 鍐欏彧鍚椂闂磋酱鐨勭绾?AAF銆?- 濯掍綋閲囨牱鐜囦笌宸ョ▼缂栬緫鐜囦笉鍚屾椂浼氬湪 warnings 閲岃鏄庯紙AAF 璇箟涓婄敱璇诲彇绔噸閲囨牱锛夈€?
### 1.4 涓庣湡姝?AAF 鐨勫樊璺濓紙瀹炴祴璇佹嵁锛屽埆璇垽锛?
AAF 鏄?*鑷弿杩?*鏍煎紡锛氬悎瑙勬枃浠跺繀椤诲湪 `/MetaDictionary-1` 閲屽祵鍏ュ畠鐢ㄥ埌鐨勬瘡涓被鐨勫畾涔?锛圕lassDefinition / PropertyDefinition / TypeDefinition锛夛紝璇诲彇绔紙AAF SDK锛夊厛瑙ｆ瀽瀛楀吀锛屽啀鐞嗚В瀵硅薄銆?
鏈疄鐜?*娌℃湁鍐欒繖灞傚瓧鍏?*銆傜敤鐙珛瀹炵幇楠岃瘉鐨勭粨鏋滐紙`pyaaf2 1.7.1`锛孭ython锛屼綔涓哄弬鐓у疄鐜帮級锛?
1. **瀹瑰櫒灞傞€氳繃**锛歱yaaf2 鐨?`CompoundFileBinary` 鑳藉畬鏁撮亶鍘嗘垜浠殑鏂囦欢鈥斺€?   52 涓?storage / 75 涓?stream锛岀被 ID 涓庢祦鍐呭鍏ㄩ儴璇诲嚭锛宍validate_directory_structure()` 閫氳繃锛?   鏍瑰瓨鍌ㄧ被 ID 涓?AAF Root `b3b398a5-1c90-11d4-8053-080036210804`銆?2. **楂樺眰璇诲彇鍦ㄥ瓧鍏稿澶辫触**锛歚aaf2.open(file, 'r')` 鎶涘嚭
   `AAFFileError: cannot find index stream: ClassDefinitions-3 index`銆?   涔熷氨鏄锛欳FB 鈫?鏍瑰璞?鈫?Header 寮曠敤 鈫?寮卞紩鐢ㄨ〃閮借璇昏繃浜嗭紝**鎭板ソ鍗″湪 MetaDictionary 鐨?   ClassDefinitions 鍚戦噺**涓娿€侾ro Tools / Media Composer / Resolve 渚濊禆鍚屼竴濂?AAF SDK 閫昏緫锛屼細鍦ㄥ悓涓€姝ユ嫆缁濄€?
鍙傜収閲忕骇锛堢敤 pyaaf2 鍐欎竴涓?0.5 s 鍗曞０閬?+ 1 涓?clip"鐨勬渶灏忕湡瀹?AAF 瀹炴祴锛夛細

- 鏂囦欢 507,904 瀛楄妭锛屽叾涓?**MetaDictionary 鐨勫睘鎬ф祦 123,078 瀛楄妭**銆?*1960 涓彲杈剧洰褰曢」**锛?- 鐩綍椤归噷绾?**907 涓槸瀛楀吀瀹氫箟瀵硅薄**锛?77 涓?TypeDefinition銆?18 涓?PropertyDefinition銆佺害 100 涓?  ClassDefinition/DataDefinition/ContainerDefinition/CodecDefinition 绛夛級锛屽叾浣欐墠鏄唴瀹瑰璞★紱
- 鍐呭瀵硅薄鍙湁 10 鏉ヤ釜锛圧oot/Header/Identification/Dictionary/ContentStorage/3 Mob/Slot/Sequence/Clip/
  PCMDescriptor/EssenceData锛夛紝鎴戜滑鐨勫啓鍏ュ櫒宸茬粡鍏ㄩ儴瑕嗙洊銆?
鎵€浠ヨ鍙樻垚"Pro Tools 鐪熻兘鎵撳紑"锛岀己鍙ｅ氨鏄?*涓€涓粠 AAF 瑙勮寖鐢熸垚瀹屾暣绫诲畾涔夎〃骞舵妸瀹冧滑鍐欐垚
DefinitionObject 鐨勬ā鍧?*锛堝惈 ParentClass銆丳ropertyDefinition 鐨勫眬閮ㄩ敭/绫诲瀷/鍙€夋爣蹇楋紝浠ュ強
`ClassDefinitions`/`PropertyDefinitions`/`TypeDefinitions` 涓変釜鍚戦噺锛夈€?
### 1.5 鍚庣画璺嚎涓庡伐浣滈噺锛堟寜渚濊禆鎺掑簭锛?
1. **绫诲畾涔夎〃**锛坄lib/aaf-schema.js`锛岀敱瑙勮寖/鍙傜収瀹炵幇瀵煎嚭鐨勯潤鎬佹暟鎹級锛氱害 15 涓璞＄被 + 瀹冧滑鐨勫睘鎬у畾涔?+
   绫诲瀷瀹氫箟 + 鏁版嵁瀹氫箟锛垀40鈥?20 涓畾涔夊璞★級銆傚伐浣滈噺 **1鈥?.5 澶?*锛岄闄╃偣鏄?907 涓畾涔夐噷鍒板簳鍝簺鏄?   "蹇呴』"鐨勨€斺€斿缓璁厛鐢?pyaaf2 鐢熸垚鏈€灏忔枃浠讹紝閫愮被鍒犲噺鍒?鑳借 pyaaf2 鎵撳紑"銆?2. **MetaDictionary 鍐欏叆鍣?*锛氭妸琛ㄥ啓鎴?`ClassDefinitions`/`PropertyDefinitions`/`TypeDefinitions` 涓変釜
   寮哄紩鐢ㄩ泦鍚堬紙鐜版湁 `serializeObject` 宸叉敮鎸佸悜閲忥級锛屽苟鎶婂璞＄殑鍔ㄦ€?PID 涓庡畾涔夊榻愩€?*0.5鈥? 澶?*銆?3. **绔埌绔獙璇?*锛氭湰鏈烘棤 AAF SDK / Pro Tools锛屽彧鑳界敤 pyaaf2 浣滀负浠ｇ悊楠岃瘉锛涚湡姝?鑳藉湪 Pro Tools 鎵撳紑"
   蹇呴』鍦ㄨ鏈?Pro Tools 鐨勬満鍣ㄤ笂楠屾敹銆?*1 澶╋紙鍚線杩斾慨澶嶏級**銆?4. 鍙€夛細`OperationGroup` 鐢靛钩/娣″叆娣″嚭銆佸閾惧獟浣擄紙NetworkLocator锛夈€佸澹伴亾浜ょ粐鏍￠獙銆?
鍚堣 **3鈥? 澶?*锛堝叾涓?1 澶╁繀椤诲湪鏈?AAF SDK/Pro Tools 鐨勭幆澧冮噷锛夈€傚湪姝や箣鍓?`audio_daw` 鐨?`aaf`
鍙兘浣滀负缁撴瀯涓庡鍣ㄨ兘鍔涚殑璇佹槑锛?*涓嶅彲褰撲氦浠樼墿**銆?
### 1.6 鍚勮蒋浠跺鍏ユ楠や笌棰勬湡缁撴灉锛堢幇鐘讹級

- **Avid Pro Tools**锛歚File > Import > Session Data鈥 閫夋嫨 `.aaf` 鈫?璇诲彇鍒板瓧鍏搁樁娈垫姤鏂囦欢鎹熷潖/鏃犳硶瑙ｆ瀽
  锛堝搴?1.4 鐨勫け璐ョ偣锛夈€傚綋鍓嶇粨鏋滄槸**鎷掔粷**锛屼笉瑕佹壙璇哄彲鐢ㄣ€?- **DaVinci Resolve**锛歚File > Import > Timeline鈥 閫?`.aaf` 鈫?鍚屾牱鍦ㄥ瓧鍏搁樁娈靛け璐ャ€?- **Adobe Premiere Pro**锛氫笉鏀寔 AAF 瀵煎叆锛堝師鐢熷彧鏀寔 FCP7 XML / FCPXML / EDL / OMF 鏃х増锛夈€?- 浠讳綍鍙仛瀹瑰櫒瑙ｆ瀽鐨勫伐鍏凤紙7-Zip 绫汇€乣olefile`銆乸yaaf2 鐨?CFB 灞傦級閮借兘鐪嬪埌瀹屾暣鐩綍鏍戜笌 PCM 娴併€?
---

## 2. OMF锛坄lib/omf.js`锛?
**鐘舵€侊細楠ㄦ灦锛屼笉鏄鍑哄櫒銆?* 鍐欏嚭鐨勬枃浠舵槸锛?
- 涓€涓悎娉?MS-CFB v3 瀹瑰櫒锛?- `/OMFI:HEADER` 娴侊細ASCII 璇存槑锛岄琛?`DSH-AUDIOKIT-OMF-SKELETON-V1`锛屾槑纭啓"杩欎笉鏄?OMF 鏂囨。"锛?- `/DSH:MANIFEST` 娴侊細UTF-8 JSON 娓呭崟锛屽寘鍚椂闂磋酱銆乧ue 鍒楄〃銆乣importable: false`銆佷互鍙婄湡瀹?OMFI 鍐欏叆鍣?  杩橀渶瑕佷骇鍑虹殑 7 绫诲璞★紙CMOB銆丆MOBGroup銆丆Track銆丆Clip銆丮MOB銆丮Media銆丮Source锛変笌缂哄け椤瑰垪琛ㄣ€?
**涓轰粈涔堜笉鍋氬畬**锛歄MFI v2 涓?AAF 鍏辩敤瀹瑰櫒浣嗗璞℃ā鍨嬫槸 Avid 绉佹湁鐨勶紙澶х銆佺被 A/B 娴併€丱MFI 澶磋褰曪級锛?娌℃湁寮€婧愬弬鐓у疄鐜板彲浠ュ鐓у瓧鑺傦紱鍗充娇鍐欏畬锛屼篃鍙兘鍦ㄨ鏈?Avid 鐨勬満鍣ㄤ笂楠屾敹銆傜敤 AAF 鐨勭粡楠屼及绠楋細
瀵硅薄鍐欏叆鍣?**400鈥?00 琛?+ 娴嬭瘯 鈮?1鈥? 澶?*锛岄獙鏀跺彟闇€ Avid 鐜銆?
瀵煎叆姝ラ锛欰vid Pro Tools `File > Import > Session Data鈥銆丮edia Composer 鐨?OMF 瀵煎叆鈥斺€斿綋鍓嶉兘浼氳鎷掔粷銆?涓嶈鎶婂畠褰撳彲鐢ㄦ牸寮忋€?
---

## 3. OpenTimelineIO锛坄lib/otio.js`锛夆€斺€?*褰撳墠鏈€鎺ㄨ崘鐨勪氦浠樻牸寮忎箣涓€**

### 3.1 鍐欏嚭鐨勭粨鏋?
`Timeline.1` 鈫?`Stack.1`锛坱racks锛夆啋 姣忔潯 lane 涓€涓?`Track.1`锛坄kind: "Audio"`锛夆啋
`Gap.1`锛堥棿闅欙級/ `Clip.2`锛堢墖娈碉紝甯?`ExternalReference.1` 濯掍綋寮曠敤锛夈€?
- `RationalTime.1` 鐨?`rate` = **闊抽閲囨牱鐜?*锛堥粯璁?48000锛屽彲鐢?`sampleRate` 鎸囧畾锛夛紝浣嶇疆鎹㈢畻鎴愰噰鏍风偣锛?  鍥犳 `at=0.5 s` 灏辨槸绗?24000 涓噰鏍风偣锛?*閫愭牱鏈簿纭?*锛堜笉鏄抚瀵归綈锛夈€?- 閲嶅彔 cue 鎵撳寘鍒颁笉鍚?`Track`锛堣建閬撳唴涓嶈兘鍚屾椂涓や釜 clip锛夛紱绌洪殭鍐欐垚 `Gap.1`锛屼繚璇佽建閬撳唴棣栧熬鐩告帴銆?- 澧炵泭/娣″叆娣″嚭锛?*OTIO 闊抽妯″瀷娌℃湁鐢靛钩瀛楁**锛屽啓杩?clip 鐨?`metadata["dsh-audiokit"]`
  锛坄gainDb`/`fadeIn`/`fadeOut`/`sourcePath`锛夛紝骞跺湪缁撴灉 warnings 閲岃鏄?蹇呴』鍦ㄥ壀杈戣蒋浠堕噷鍐嶅鐢?銆?  涓嶄吉閫犱笉瀛樺湪鏁堟灉銆?
### 3.2 鐙珛楠岃瘉

鐢?**opentimelineio 0.18.1锛堝畼鏂?Python 搴擄級** 璇诲洖娴嬭瘯浜х墿锛?
```
name: interop test          duration: RationalTime(156000, 48000)   tracks: 2
track 0 Audio Lane 1  clip boom@0+72000  clip ding@72000+36000  clip swell@108000+48000
track 1 Audio Lane 2  gap 24000  clip overlap@24000+24000
media: file:///project/assets/boom.wav 鈥︼紙鍏ㄩ儴瑙ｆ瀽鎴愬姛锛?```

### 3.3 瀵煎叆姝ラ

- **DaVinci Resolve 18+**锛歚File > Import > Timeline鈥 鈫?閫?`.otio`锛涢煶棰戞椂闂磋酱鎸?lane 鍙樻垚闊宠建銆?- **Nuke / 鍏朵粬 OTIO 宸ュ叿**锛歚opentimelineio.adapters.read_from_file` 鐩存帴璇汇€?- **Premiere Pro**锛氶渶瀹夎 OpenTimelineIO 閫傞厤鍣紙`otio` 鐨?Premiere/FCP XML 妗ユ帴锛夛紝鍚﹀垯涓嶈 `.otio`銆?- **Pro Tools**锛氫笉鏀寔 OTIO銆?
### 3.4 宸茬煡闄愬埗

- 鏃犵數骞?娣″叆娣″嚭瀛楁锛堣涓婏紝metadata 閲屼繚鐣欙級銆?- `target_url` 鍐欑殑鏄?*鐩稿宸ヤ綔鐩綍鐨勮矾寰?*锛堟崲鏈哄櫒闇€閲嶉摼锛夛紱xmeml 閲屽啓鐨勬槸缁濆 `file://` URL銆?- 涓嶆敮鎸佽浆鍦恒€佸彉閫熴€佹爣璁帮紙markers锛夈€佸祵濂?stack锛涙湰鎻掍欢鐨勬椂闂磋酱妯″瀷鐢ㄤ笉鍒般€?
---

## 4. FCP7 XML / xmeml锛坄lib/xmeml.js`锛夆€斺€?*鍙︿竴涓彲鐩存帴浜や粯鐨勬牸寮?*

### 4.1 鍐欏嚭鐨勭粨鏋?
`<xmeml version="4">` 鈫?`<sequence>` 鈫?`<media><video><format>`锛堜粎鐢婚潰鍙傛暟锛塦<audio>` 鈫?姣忔潯 lane 涓€涓?`<track>` 鈫?姣忎釜 cue 涓€涓?`<clipitem>`锛?
- `<start>/<end>`锛堣建閬撲綅缃紝甯э級銆乣<in>/<out>`锛堟簮鍐呰寖鍥达紝甯э級銆乣<file>`锛坄<name>`銆乣<pathurl>`
  **缁濆 file:// URL**銆乣<rate>`銆乣<duration>`銆乣<timecode>`銆乣<media><audio>` 閲囨牱鍙傛暟锛夈€?  `<sourcetrack><mediatype>audio</mediatype>`锛?- 澧炵泭 鈫?鏍囧噯 **`Audio Levels` 婊ら暅**锛坄effectid: audiolevels`锛宍<value>` 鏄嚎鎬у箙搴︼紝1.0 = 0 dB锛夛紝
  Premiere 涓?Resolve 閮戒細鏄犲皠鎴愮墖娈甸煶閲忥紱娴嬭瘯瀹炴祴 -6 dB 鈫?0.501187 骞惰兘璇诲洖 -6.00 dB銆?- 甯х巼锛氶粯璁?25锛屽彲閫?24/25/30/50/60/23.976/29.97锛?9.97 鍐欐垚 `<timebase>30</timebase><ntsc>TRUE</ntsc>`
  骞朵娇鐢ㄤ涪甯ф椂闂寸爜锛堝垎鍙凤級銆?
### 4.2 鐙珛楠岃瘉

鐢?Python 鏍囧噯搴?`ElementTree`锛堢嫭绔嬭В鏋愬櫒锛夎В鏋愭祴璇曚骇鐗╋細

```
root: xmeml version=4  sequence name="interop test" duration=81  rate 25 / FALSE
audio tracks: 2, clipitems: 4
  track0 boom start=0 end=38 in=0 out=38 url=file:///project/assets/boom.wav
  track0 ding start=38 end=56  filter: Audio Levels level 0.501187
  track1 overlap start=13 end=25 in=0 out=12
```

### 4.3 瀵煎叆姝ラ

- **Premiere Pro**锛歚File > Import鈥 鈫?閫?`.xml`锛團inal Cut Pro XML锛夛紱浼氱敓鎴愪竴涓簭鍒楋紝闊宠建鎸?lane 鎺掑垪锛?  濯掍綋鎸?`<pathurl>` 鑷姩閾炬帴锛堣矾寰勪笉瀛樺湪鏃朵細鎻愮ず閲嶉摼锛夈€?- **DaVinci Resolve**锛歚File > Import Timeline鈥 鈫?閫?xmeml `.xml`锛涢煶棰戝簭鍒楁甯革紝鐢婚潰涓虹┖鐨?1920脳1080
  搴忓垪鍙傛暟锛堟湰瀵煎嚭鏄函闊抽锛夈€?- **Pro Tools / Avid**锛氫笉瀵煎叆 FCP7 XML銆?
### 4.4 宸茬煡闄愬埗

- **甯ч噺鍖?*锛歚start/end` 鏄暣鏁板抚锛宍at=0.25 s` 鍦?25 fps 涓婅惤鍒扮 6 甯э紙0.24 s锛夈€傜粨鏋滈噷浼氭姤"鏈€鍧忓亸绉诲灏?ms"
  锛?5 fps 涓€甯?40 ms锛夈€傝閫愭牱鏈簿纭鐢?`otio`銆?- **娣″叆娣″嚭涓嶅啓**锛欶CP7 鐢?`<transitionitem>`/Cross Fade 琛ㄧず娣″彉锛屽悇绉嶈В璇讳笉涓€鑷达紝鏈鍑轰笉浼€狅紝
  鍙湪 warnings 閲岃鏄庨渶鍦ㄨ蒋浠堕噷琛ワ紙澧炵泭宸插啓锛夈€?- 闊抽涓哄崟澹伴亾璇箟锛坄<channelcount>1</channelcount>`锛夛紱绔嬩綋澹扮礌鏉愰渶瑕佸湪姝ゅ熀纭€鎵╁睍銆?- 闊抽搴忓垪娌℃湁瑙嗛 clipitem锛堝彧鏈夌敾闈㈠弬鏁板潡锛夛紝Resolve 浼氬緱鍒颁竴鏉＄┖瑙嗛杞ㄣ€?
---

## 5. 瀛楁鏄犲皠鎬昏〃

| 杈撳叆 | edl | rpp | csv | labels | **aaf** | **omf** | **otio** | **xmeml** |
|---|---|---|---|---|---|---|---|---|
| name | 娉ㄩ噴 | NAME | 鍒?| 鏍囩 | Mob/Slot 鍚?| 娓呭崟 | clip.name | clipitem name |
| path | 娉ㄩ噴 | FILE | 鍒?| 鈥?| 绂荤嚎鏍囪 | 娓呭崟 | target_url | pathurl |
| at | 璁板綍鏃剁爜 | POSITION | 鍒?| 璧风偣 | Slot 鍐呯墖娈典綅缃紙閲囨牱鐐癸級 | 娓呭崟 | RationalTime | start 甯?|
| duration | 璁板綍鏃剁爜宸?| LENGTH | 鍒?| 缁堢偣 | SourceClip.Length | 娓呭崟 | source_range | end-in 甯?|
| gainDb | 娉ㄩ噴 | VOLPAN | 鍒?| 鈥?| 鉂?| 娓呭崟 | metadata | Audio Levels |
| fadeIn/Out | 娉ㄩ噴 | FADEIN/FADEOUT | 鍒?| 鈥?| 鉂?| 娓呭崟 | metadata | 鉂岋紙璀﹀憡锛?|

---

## 6. 纭畾鎬?
鍥涗釜鏂版牸寮忛兘婊¤冻"鍚屼竴璇锋眰 = 鍚屼竴瀛楄妭"锛堟祴璇曢€愬瓧鑺傛柇瑷€锛夛細

- AAF/OMF锛氬鍣ㄦ椂闂存埑鍐?0锛孶MID 鐢?SHA-256 娲剧敓锛屾棤鏃堕挓/闅忔満鏁帮紱
- OTIO锛歚JSON.stringify` 鍥哄畾閿簭锛屾椂闂村叏閮ㄧ敱閲囨牱鐜囨崲绠楋紱
- xmeml锛氭墜鍐欏瓧绗︿覆鎷兼帴锛屾暟瀛楁牸寮忓寲涓嶄緷璧?locale锛屾崲琛屾亽涓?`\n`銆?
宸ュ叿灞備粛鎸?璇锋眰鍐呭 hash"鍛藉悕榛樿杈撳嚭鏂囦欢锛坄assets/audio/<format>-<hash>.<ext>`锛夛紝
鍥犳閲嶅璋冪敤浼氳惤鍦ㄥ悓涓€璺緞銆佸悓涓€瀛楄妭銆?
---

## 7. 娴嬭瘯

鏂板娴嬭瘯锛堣８ `node`锛岄浂渚濊禆锛岄鏍间笌 `test/daw.mjs` 涓€鑷达紱`tools/test-all.mjs` 鑷姩鍙戠幇 `test/*.mjs`锛屾棤闇€鐧昏锛夛細

```bash
node test/daw.mjs       # 251 checks锛氬師鏈夊洓鏍煎紡 + 鏂?format 鐨勭‘瀹氭€?鎵╁睍鍚?浜岃繘鍒跺垎鏀?node test/daw-aaf.mjs   # 193 checks锛欳FB 瀹瑰櫒涓庣洰褰曠孩榛戞爲銆丄AF 瀵硅薄鍥俱€乪ssence 褰掑睘閾俱€丳CM 閫愬瓧鑺傘€佺绾挎ā寮忋€佸伐鍏峰眰
node test/daw-otio.mjs  # 165 checks锛歄TIO 缁撴瀯/涓嶅彉閲?寰€杩斻€亁meml 缁撴瀯/甯х巼/寰€杩斻€丱MF 楠ㄦ灦璇氬疄鎬с€佸伐鍏峰眰
```

`test/daw-aaf.mjs` 闄や簡寰€杩旓紝杩樺仛**鍏ㄥ浘寮曠敤瀹屾暣鎬?*妫€鏌ワ細姣忎釜 `properties` 娴侀兘鑳借В鐮侊紱姣忔潯寮哄紩鐢ㄥ湪
鎸佹湁瀹冪殑瀵硅薄涓嬮兘鑳芥壘鍒板悓鍚嶅瓙瀛樺偍锛涙瘡涓悜閲忕殑绱㈠紩娴佹潯鐩兘鑳芥壘鍒板搴斿瓙瀛樺偍锛涙瘡涓瓨鍌ㄧ殑绫?ID 閮藉睘浜?鍐欏叆鍣ㄥ０绉扮殑 AAF 绫婚泦鍚堛€傝繖鏄?瀛楄妭鑷唇"鐨勬満鍣ㄨ瘉鎹紝涔熸槸褰撳墠鑳藉仛鍒扮殑鏈€寮鸿瘉鏄庛€?
姝ゅ杩樻湁涓ょ粍缁撴瀯涓嶅彉閲忥紙閮芥槸瑙ｇ爜鐪熷疄瀛楄妭锛屼笉渚濊禆鍐欏叆鍣ㄨ嚜鎶ワ級锛?
- **鐩綍鏍?*锛氬 1/2/3/7/15 涓瓙椤瑰拰 AAF 鐨?ContentStorage锛屼粠鍘熷鐩綍椤归獙璇佹繁搴?鈮?`2路log2(n)+2`銆?  宸﹀彸榛戦珮鐩哥瓑銆佹棤绾㈢孩杈广€佹牴涓洪粦銆佷腑搴忛『搴忕鍚?CFB 瑙勫垯鈥斺€旇繖鏄?閫€鍖栨垚閾?浼氱珛鍒诲け璐ョ殑妫€鏌ワ紱
- **essence 褰掑睘閾?*锛歚validateAafGraph` 鍦?`parseAaf` 鏈熬杩愯锛屾柇瑷€ essence 鎸囧悜甯?descriptor 鐨?  SourceMob銆丼ourceMob 鐨?slot 闀垮害绛変簬 descriptor 闀垮害銆佹ā鍨嬮噷娌℃湁鍏?0 UMID銆佹墍鏈夊紩鐢ㄥ彲瑙ｆ瀽锛?  娴嬭瘯鍙﹀鐢?4 涓?鏁呮剰鎵撴柇閾?鐨勫壇鏈紙essence 鎸囧悜 master銆侀暱搴﹀樊 1銆佸叏 0 UMID銆佹偓绌哄紩鐢級璇佹槑瀹冪湡鐨勪細鎷掔粷銆?
---

## 8. 缁撹

- **鑳戒氦浠?*锛歚otio`銆乣xmeml`锛堝垎鍒 opentimelineio 涓?ElementTree 鐙珛璇诲洖锛孯esolve/Premiere 鍙鍏ワ級銆?- **鑳借瘉鏄庝笉鑳戒氦浠?*锛歚aaf`锛堝鍣?瀵硅薄鍥?宓屽叆 PCM 鐪熷疄锛岀己 MetaDictionary 瀛楀吀灞傦紝AAF SDK 绯昏蒋浠跺湪瀛楀吀澶勬嫆缁濓級銆?- **鏄庣‘鍗犱綅**锛歚omf`锛堥鏋?+ 娓呭崟 + 璇存槑锛孉vid 蹇呮嫆缁濓級銆?- **涓嶈**鍦?README/宸ュ叿鎻忚堪閲屾妸 aaf 璇存垚"Pro Tools 鍙鍏?锛沗audio_daw` 鐨?aaf 缁撴灉閲?  `importable: false`銆乣structure.metaDictionary: "absent"`锛屽伐鍏锋枃妗堜篃鍐欎簡杩欎竴鐐广€?